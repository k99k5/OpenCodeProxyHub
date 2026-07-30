import https from "node:https";
import type { ServerResponse } from "node:http";
import { ocId } from "../utils/ids.js";
import type { AppConfig } from "../config/env.js";
import type { ZenFullResponse } from "../types/api.js";
import type { ProxyLease, ProxyPoolStore } from "../proxy/proxyPool.js";
import type { MetricsStore } from "../observability/metrics.js";

const OC_VERSION = "1.15.0";
const noProxyAvailableError =
  "Proxy is required but no proxy node is available";

export interface ZenRequestInput {
  model: string;
  messages: unknown[];
  stream?: boolean;
  tools?: unknown[];
  toolChoice?: unknown;
  parameters?: Record<string, unknown>;
  sessionId: string;
}

export interface ZenPreparedRequest {
  body: string;
  options: https.RequestOptions;
  lease?: ProxyLease;
}

const MAX_PROXY_ATTEMPTS = 3;

const replaceProxyLease = (
  prepared: ZenPreparedRequest,
  proxyPool: ProxyPoolStore,
  attemptedProxyIds: Set<string>,
): boolean => {
  const lease = proxyPool.acquire(attemptedProxyIds);
  if (!lease.node || !lease.agent) return false;
  attemptedProxyIds.add(lease.node.id);
  prepared.lease = lease;
  prepared.options.agent = lease.agent;
  return true;
};

const shouldRetryStatus = (statusCode: number): boolean =>
  statusCode === 429 || statusCode >= 500;

export const prepareZenRequest = (
  config: AppConfig,
  input: ZenRequestInput,
  proxyPool?: ProxyPoolStore,
): ZenPreparedRequest => {
  const requestBody: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    stream: Boolean(input.stream),
  };
  if (input.tools?.length) requestBody.tools = input.tools;
  if (input.toolChoice) requestBody.tool_choice = input.toolChoice;
  for (const [key, value] of Object.entries(input.parameters || {})) {
    if (value !== undefined) requestBody[key] = value;
  }

  const body = JSON.stringify(requestBody);
  const requestId = ocId("msg");

  const lease = proxyPool?.acquire();
  return {
    body,
    options: {
      hostname: config.zenHost,
      port: 443,
      path: config.zenPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: "Bearer public",
        "User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": requestId,
        "x-opencode-session": input.sessionId,
      },
      ...(lease?.agent ? { agent: lease.agent } : {}),
      timeout: config.upstreamTimeoutMs,
    },
    lease,
  };
};

export const requestZenFull = (
  prepared: ZenPreparedRequest,
  proxyPool?: ProxyPoolStore,
  metrics?: MetricsStore,
): Promise<ZenFullResponse> => {
  return new Promise((resolve, reject) => {
    if (prepared.lease?.requiredUnavailable) {
      reject(new Error(noProxyAvailableError));
      return;
    }
    const attemptedProxyIds = new Set<string>();
    if (prepared.lease?.node) attemptedProxyIds.add(prepared.lease.node.id);
    let settled = false;

    const attempt = (): void => {
      const started = process.hrtime.bigint();
      const durationMs = () =>
        Number(process.hrtime.bigint() - started) / 1_000_000;
      const attemptProxyId = prepared.lease?.node?.id;
      let failed = false;
      let timedOut = false;
      const failCurrent = (message: string, statusCode: number): void => {
        if (failed || !attemptProxyId || !proxyPool) return;
        failed = true;
        proxyPool.markFailure(attemptProxyId, message, { statusCode });
      };
      const retry = (): boolean =>
        Boolean(
          proxyPool &&
          attemptedProxyIds.size < MAX_PROXY_ATTEMPTS &&
          replaceProxyLease(prepared, proxyPool, attemptedProxyIds),
        );

      const req = https.request(prepared.options, (zenRes) => {
        const chunks: Buffer[] = [];
        zenRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        zenRes.on("end", () => {
          const statusCode = zenRes.statusCode || 502;
          if (shouldRetryStatus(statusCode)) {
            failCurrent(`Upstream returned ${statusCode}`, statusCode);
            if (retry()) {
              metrics?.recordUpstream({
                statusCode,
                durationMs: durationMs(),
                proxyId: attemptProxyId,
              });
              attempt();
              return;
            }
          } else if (attemptProxyId && proxyPool) {
            proxyPool.markSuccess(attemptProxyId);
          }
          metrics?.recordUpstream({
            statusCode,
            durationMs: durationMs(),
            proxyId: attemptProxyId,
          });
          const raw = Buffer.concat(chunks).toString();
          settled = true;
          try {
            resolve({ status: statusCode, data: JSON.parse(raw), raw });
          } catch {
            resolve({ status: statusCode, data: null, raw });
          }
        });
      });

      req.on("error", (error) => {
        if (settled) return;
        const statusCode = timedOut ? 504 : 502;
        const message = timedOut ? "Upstream timeout" : error.message;
        failCurrent(message, statusCode);
        metrics?.recordUpstream({
          statusCode,
          durationMs: durationMs(),
          proxyId: attemptProxyId,
          error: message,
        });
        if (retry()) {
          attempt();
          return;
        }
        settled = true;
        reject(timedOut ? new Error(message) : error);
      });
      req.on("timeout", () => {
        timedOut = true;
        req.destroy(new Error("Upstream timeout"));
        // The resulting error event owns retry/rejection so this attempt is handled once.
      });
      req.write(prepared.body);
      req.end();
    };

    attempt();
  });
};

export const pipeZenOpenAIResponse = (
  prepared: ZenPreparedRequest,
  stream: boolean,
  res: ServerResponse,
  proxyPool?: ProxyPoolStore,
  metrics?: MetricsStore,
): void => {
  if (prepared.lease?.requiredUnavailable) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: noProxyAvailableError, type: "proxy_unavailable" },
      }),
    );
    return;
  }
  const attemptedProxyIds = new Set<string>();
  if (prepared.lease?.node) attemptedProxyIds.add(prepared.lease.node.id);
  let activeReq: ReturnType<typeof https.request> | undefined;
  let finished = false;

  res.on("close", () => {
    if (activeReq && !activeReq.destroyed) activeReq.destroy();
  });

  const startAttempt = (): void => {
    const started = process.hrtime.bigint();
    const durationMs = () =>
      Number(process.hrtime.bigint() - started) / 1_000_000;
    const attemptProxyId = prepared.lease?.node?.id;
    let markedFailure = false;
    let timedOut = false;
    let superseded = false;
    const failCurrent = (message: string, statusCode: number): void => {
      if (markedFailure || !attemptProxyId || !proxyPool) return;
      markedFailure = true;
      proxyPool.markFailure(attemptProxyId, message, { statusCode });
    };
    const retry = (): boolean => {
      if (
        !proxyPool ||
        res.headersSent ||
        attemptedProxyIds.size >= MAX_PROXY_ATTEMPTS
      )
        return false;
      if (!replaceProxyLease(prepared, proxyPool, attemptedProxyIds))
        return false;
      superseded = true;
      startAttempt();
      return true;
    };

    const attemptReq = https.request(prepared.options, (zenRes) => {
      const statusCode = zenRes.statusCode || 502;
      if (shouldRetryStatus(statusCode)) {
        const hasRetryCapacity =
          proxyPool && attemptedProxyIds.size < MAX_PROXY_ATTEMPTS;
        if (
          hasRetryCapacity &&
          replaceProxyLease(prepared, proxyPool, attemptedProxyIds)
        ) {
          superseded = true;
          zenRes.once("close", () => {
            failCurrent(`Upstream returned ${statusCode}`, statusCode);
            metrics?.recordUpstream({
              statusCode,
              durationMs: durationMs(),
              proxyId: attemptProxyId,
            });
            startAttempt();
          });
          zenRes.destroy();
          return;
        }
      }
      let firstChunk: Buffer | null = null;
      let headersSent = false;

      zenRes.on("data", (chunk: Buffer) => {
        if (!firstChunk) {
          firstChunk = chunk;
          const str = chunk.toString().trim();
          if (
            str.startsWith("{") &&
            (str.includes("FreeUsageLimitError") || str.includes('"error"'))
          ) {
            try {
              const parsed = JSON.parse(str);
              if (parsed.error || parsed.type === "error") {
                const errMsg =
                  parsed.error?.message ||
                  parsed.message ||
                  "Rate limit exceeded";
                failCurrent(errMsg, 429);
                if (!res.headersSent) {
                  res.writeHead(429, { "Content-Type": "application/json" });
                  res.end(
                    JSON.stringify({
                      error: {
                        message: `${errMsg} (free model rate limit)`,
                        type: "rate_limit_error",
                        code: "rate_limit_exceeded",
                      },
                    }),
                  );
                }
                zenRes.resume();
                return;
              }
            } catch {
              // Continue with normal passthrough.
            }
          }

          headersSent = true;
          if (stream) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
              "Transfer-Encoding": "chunked",
            });
          } else {
            res.writeHead(zenRes.statusCode || 502, {
              "Content-Type": "application/json",
            });
          }
          res.write(firstChunk);
          return;
        }

        if (headersSent) res.write(chunk);
      });

      zenRes.on("end", () => {
        if (attemptProxyId && proxyPool && !markedFailure) {
          if (shouldRetryStatus(statusCode))
            proxyPool.markFailure(
              attemptProxyId,
              `Upstream returned ${statusCode}`,
              {
                statusCode,
              },
            );
          else proxyPool.markSuccess(attemptProxyId);
        }
        metrics?.recordUpstream({
          statusCode,
          durationMs: durationMs(),
          proxyId: attemptProxyId,
        });
        if (!headersSent && !firstChunk) {
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: {
                  message: "Empty response from upstream",
                  type: "upstream_error",
                },
              }),
            );
          }
          return;
        }
        if (headersSent) res.end();
      });
    });
    activeReq = attemptReq;

    attemptReq.on("error", (error) => {
      if (finished || superseded) return;
      const statusCode = timedOut ? 504 : 502;
      const message = timedOut ? "Upstream timeout" : error.message;
      failCurrent(message, statusCode);
      metrics?.recordUpstream({
        statusCode,
        durationMs: durationMs(),
        proxyId: attemptProxyId,
        error: message,
      });
      if (retry()) return;
      finished = true;
      if (!res.headersSent) {
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message,
              type: timedOut ? "timeout_error" : "upstream_error",
            },
          }),
        );
      }
    });

    attemptReq.on("timeout", () => {
      timedOut = true;
      attemptReq.destroy(new Error("Upstream timeout"));
    });

    attemptReq.write(prepared.body);
    attemptReq.end();
  };

  startAttempt();
};
