import https from "node:https";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ocId } from "../utils/ids.js";
import type { AppConfig } from "../config/env.js";
import type { ZenFullResponse } from "../types/api.js";
import type { ProxyLease, ProxyPoolStore } from "../proxy/proxyPool.js";
import type { MetricsStore } from "../observability/metrics.js";
import {
  armProxyConnectTimeout,
  resolveProxyConnectTimeoutError,
  type ArmedProxyConnectTimeout,
} from "../proxy/connectTimeout.js";

const OC_VERSION = "1.15.0";
const noProxyAvailableError =
  "Proxy is required but no proxy node is available";
export const EMPTY_UPSTREAM_RESPONSE_MESSAGE =
  "Empty response from upstream";

export interface ZenRequestInput {
  model: string;
  messages: unknown[];
  stream?: boolean;
  tools?: unknown[];
  toolChoice?: unknown;
  parameters?: Record<string, unknown>;
  promptCacheKey?: string;
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

const resolveRequestFailure = (
  error: Error,
  upstreamTimedOut: boolean,
  proxyConnectTimeout: ArmedProxyConnectTimeout,
): { error: Error; message: string; statusCode: number; timedOut: boolean } => {
  const proxyTimeoutError = resolveProxyConnectTimeoutError(
    error,
    proxyConnectTimeout,
  );
  if (proxyTimeoutError) {
    return {
      error: proxyTimeoutError,
      message: proxyTimeoutError.message,
      statusCode: 504,
      timedOut: true,
    };
  }
  if (upstreamTimedOut) {
    const timeoutError = new Error("Upstream timeout");
    return {
      error: timeoutError,
      message: timeoutError.message,
      statusCode: 504,
      timedOut: true,
    };
  }
  return {
    error,
    message: error.message,
    statusCode: 502,
    timedOut: false,
  };
};

export interface ZenRetryingStream {
  destroy(): void;
}

export interface ZenStreamResponseControl {
  retryFailure(error: Error, statusCode?: number): boolean;
}

export const requestZenStreamWithRetry = (
  prepared: ZenPreparedRequest,
  proxyPool: ProxyPoolStore | undefined,
  metrics: MetricsStore | undefined,
  onResponse: (
    response: IncomingMessage,
    proxyId: string | undefined,
    durationMs: () => number,
    control: ZenStreamResponseControl,
  ) => void,
  onError: (error: Error, statusCode: number) => void,
): ZenRetryingStream => {
  const attemptedProxyIds = new Set<string>();
  if (prepared.lease?.node) attemptedProxyIds.add(prepared.lease.node.id);
  let activeRequest: ReturnType<typeof https.request> | undefined;
  let stopped = false;

  const attempt = (): void => {
    const started = process.hrtime.bigint();
    const durationMs = () =>
      Number(process.hrtime.bigint() - started) / 1_000_000;
    const proxyId = prepared.lease?.node?.id;
    let superseded = false;
    let timedOut = false;
    let responseAccepted = false;
    const fail = (message: string, statusCode: number) => {
      if (proxyId && proxyPool)
        proxyPool.markFailure(proxyId, message, { statusCode });
    };
    const retry = (): boolean => {
      if (stopped || !proxyPool || attemptedProxyIds.size >= MAX_PROXY_ATTEMPTS)
        return false;
      if (!replaceProxyLease(prepared, proxyPool, attemptedProxyIds))
        return false;
      superseded = true;
      attempt();
      return true;
    };

    const request = https.request(prepared.options, (response) => {
      const statusCode = response.statusCode || 502;
      if (
        shouldRetryStatus(statusCode) &&
        proxyPool &&
        attemptedProxyIds.size < MAX_PROXY_ATTEMPTS &&
        replaceProxyLease(prepared, proxyPool, attemptedProxyIds)
      ) {
        superseded = true;
        response.once("close", () => {
          fail(`Upstream returned ${statusCode}`, statusCode);
          metrics?.recordUpstream({
            statusCode,
            durationMs: durationMs(),
            proxyId,
          });
          if (!stopped) attempt();
        });
        response.destroy();
        return;
      }
      responseAccepted = true;
      let responseFinished = false;
      const retryFailure = (error: Error, failureStatusCode = 502): boolean => {
        if (responseFinished || stopped) return false;
        responseFinished = true;
        fail(error.message, failureStatusCode);
        metrics?.recordUpstream({
          statusCode: failureStatusCode,
          durationMs: durationMs(),
          proxyId,
          error: error.message,
        });
        return retry();
      };
      onResponse(response, proxyId, durationMs, { retryFailure });
      const handleResponseFailure = (error: Error): void => {
        if (responseFinished || stopped) return;
        responseFinished = true;
        fail(error.message, 502);
        metrics?.recordUpstream({
          statusCode: 502,
          durationMs: durationMs(),
          proxyId,
          error: error.message,
        });
        onError(error, 502);
      };
      response.once("end", () => {
        responseFinished = true;
      });
      response.once("aborted", () => {
        handleResponseFailure(new Error("Upstream response aborted"));
      });
      response.once("error", handleResponseFailure);
    });
    const proxyConnectTimeout = armProxyConnectTimeout(
      request,
      prepared.lease?.connection,
    );
    activeRequest = request;
    request.on("error", (error) => {
      if (stopped || superseded || responseAccepted) return;
      const failure = resolveRequestFailure(
        error,
        timedOut,
        proxyConnectTimeout,
      );
      fail(failure.message, failure.statusCode);
      metrics?.recordUpstream({
        statusCode: failure.statusCode,
        durationMs: durationMs(),
        proxyId,
        error: failure.message,
      });
      if (!retry()) onError(failure.error, failure.statusCode);
    });
    request.on("timeout", () => {
      timedOut = true;
      request.destroy(new Error("Upstream timeout"));
    });
    request.write(prepared.body);
    request.end();
  };

  attempt();
  return {
    destroy: () => {
      stopped = true;
      activeRequest?.destroy();
      const proxyId = prepared.lease?.node?.id;
      if (proxyId && proxyPool) proxyPool.release(proxyId);
    },
  };
};

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
  if (input.promptCacheKey !== undefined)
    requestBody.prompt_cache_key = input.promptCacheKey;
  for (const [key, value] of Object.entries(input.parameters || {})) {
    if (value !== undefined) requestBody[key] = value;
  }

  const body = JSON.stringify(requestBody);
  const requestId = ocId("msg");
  const sessionAffinityHash =
    input.promptCacheKey === undefined
      ? undefined
      : createHash("sha256").update(input.promptCacheKey).digest("hex");

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
        "x-opencode-session": sessionAffinityHash
          ? `sess_${sessionAffinityHash}`
          : input.sessionId,
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
      let superseded = false;
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
          const raw = Buffer.concat(chunks).toString();
          if (
            statusCode >= 200 &&
            statusCode < 300 &&
            raw.trim().length === 0
          ) {
            const error = new Error(EMPTY_UPSTREAM_RESPONSE_MESSAGE);
            failCurrent(error.message, 502);
            metrics?.recordUpstream({
              statusCode: 502,
              durationMs: durationMs(),
              proxyId: attemptProxyId,
              error: error.message,
            });
            if (retry()) {
              superseded = true;
              attempt();
              return;
            }
            settled = true;
            reject(error);
            return;
          }
          if (shouldRetryStatus(statusCode)) {
            failCurrent(`Upstream returned ${statusCode}`, statusCode);
            if (retry()) {
              superseded = true;
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
          settled = true;
          try {
            resolve({ status: statusCode, data: JSON.parse(raw), raw });
          } catch {
            resolve({ status: statusCode, data: null, raw });
          }
        });
      });
      const proxyConnectTimeout = armProxyConnectTimeout(
        req,
        prepared.lease?.connection,
      );

      req.on("error", (error) => {
        if (settled || superseded) return;
        const failure = resolveRequestFailure(
          error,
          timedOut,
          proxyConnectTimeout,
        );
        failCurrent(failure.message, failure.statusCode);
        metrics?.recordUpstream({
          statusCode: failure.statusCode,
          durationMs: durationMs(),
          proxyId: attemptProxyId,
          error: failure.message,
        });
        if (retry()) {
          superseded = true;
          attempt();
          return;
        }
        settled = true;
        reject(failure.error);
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
        if (
          statusCode >= 200 &&
          statusCode < 300 &&
          !headersSent &&
          !firstChunk
        ) {
          failCurrent(EMPTY_UPSTREAM_RESPONSE_MESSAGE, 502);
          metrics?.recordUpstream({
            statusCode: 502,
            durationMs: durationMs(),
            proxyId: attemptProxyId,
            error: EMPTY_UPSTREAM_RESPONSE_MESSAGE,
          });
          if (retry()) return;
          finished = true;
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: {
                  message: EMPTY_UPSTREAM_RESPONSE_MESSAGE,
                  type: "upstream_error",
                },
              }),
            );
          }
          return;
        }
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
                  message: EMPTY_UPSTREAM_RESPONSE_MESSAGE,
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
    const proxyConnectTimeout = armProxyConnectTimeout(
      attemptReq,
      prepared.lease?.connection,
    );
    activeReq = attemptReq;

    attemptReq.on("error", (error) => {
      if (finished || superseded) return;
      const failure = resolveRequestFailure(
        error,
        timedOut,
        proxyConnectTimeout,
      );
      failCurrent(failure.message, failure.statusCode);
      metrics?.recordUpstream({
        statusCode: failure.statusCode,
        durationMs: durationMs(),
        proxyId: attemptProxyId,
        error: failure.message,
      });
      if (retry()) return;
      finished = true;
      if (!res.headersSent) {
        res.writeHead(failure.statusCode, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: failure.message,
              type: failure.timedOut ? "timeout_error" : "upstream_error",
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
