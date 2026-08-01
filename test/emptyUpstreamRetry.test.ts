import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { pipeZenAsAnthropic } from "../src/converters/anthropic.js";
import { pipeAnthropicSseAsOpenAI } from "../src/converters/anthropicSseToOpenAi.js";
import { pipeOpenAiStreamStrippingThink } from "../src/converters/openAiThinkTagToReasoning.js";
import { MetricsStore } from "../src/observability/metrics.js";
import {
  EMPTY_UPSTREAM_RESPONSE_MESSAGE,
  pipeZenOpenAIResponse,
  requestZenFull,
  type ZenPreparedRequest,
} from "../src/providers/zenClient.js";
import type {
  ProxyLease,
  ProxyNode,
  ProxyPoolStore,
} from "../src/proxy/proxyPool.js";

class FakeClientRequest extends EventEmitter {
  destroyed = false;

  constructor(
    private readonly onEnd: () => void = () => undefined,
  ) {
    super();
  }

  write(): boolean {
    return true;
  }

  end(): this {
    this.onEnd();
    return this;
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => {
      if (error) this.emit("error", error);
      this.emit("close");
    });
    return this;
  }
}

class FakeServerResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  statusCode = 200;
  readonly chunks: Buffer[] = [];

  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.headersSent = true;
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (this.writableEnded) return this;
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    queueMicrotask(() => {
      this.emit("finish");
      this.emit("close");
    });
    return this;
  }

  body(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

interface RecordedFailure {
  id: string;
  error: string;
  statusCode?: number;
}

interface FakePool {
  pool: ProxyPoolStore;
  initialLease: ProxyLease;
  failures: RecordedFailure[];
  successes: string[];
  acquiredAfterInitial: string[];
}

const proxyNode = (id: string): ProxyNode => ({
  id,
  name: id,
  type: "http",
  url: `http://${id}.example:8080`,
  source: null,
  enabled: true,
  disabledReason: null,
  weight: 1,
  maxConcurrency: 1,
  currentConcurrency: 0,
  dailyRequestLimit: 0,
  dailyRequestCount: 0,
  dailyCountDate: "2026-07-31",
  autoDisableWhenDailyLimitReached: false,
  consecutiveRateLimitCount: 0,
  cooldownUntil: null,
  successCount: 0,
  failCount: 0,
  recentResults: [],
  lastError: null,
  lastUsedAt: null,
  lastCheckedAt: null,
});

const createFakePool = (ids: string[]): FakePool => {
  assert.ok(ids.length > 0);
  const leases = new Map(
    ids.map((id) => [
      id,
      {
        node: proxyNode(id),
        agent: {} as https.Agent,
      } satisfies ProxyLease,
    ]),
  );
  const failures: RecordedFailure[] = [];
  const successes: string[] = [];
  const acquiredAfterInitial: string[] = [];

  const pool = {
    acquire(excludedIds: ReadonlySet<string>) {
      const nextId = ids.find((id) => !excludedIds.has(id));
      if (!nextId) return { node: null };
      acquiredAfterInitial.push(nextId);
      return leases.get(nextId);
    },
    markFailure(
      id: string,
      error: string,
      options: { statusCode?: number } = {},
    ) {
      failures.push({ id, error, statusCode: options.statusCode });
    },
    markSuccess(id: string) {
      successes.push(id);
    },
    release() {
      return;
    },
  } as unknown as ProxyPoolStore;

  return {
    pool,
    initialLease: leases.get(ids[0]!)!,
    failures,
    successes,
    acquiredAfterInitial,
  };
};

const preparedRequest = (lease: ProxyLease): ZenPreparedRequest => ({
  body: "{}",
  options: { agent: lease.agent },
  lease,
});

interface UpstreamResponse {
  body: string;
  statusCode?: number;
}

const installUpstreamResponses = (
  responses: UpstreamResponse[],
): { requestCount: () => number; restore: () => void } => {
  const originalRequest = https.request;
  let requestCount = 0;

  https.request = ((
    _options: https.RequestOptions,
    callback?: (response: IncomingMessage) => void,
  ) => {
    const responseConfig = responses[requestCount];
    requestCount += 1;
    assert.ok(responseConfig, `Unexpected upstream request #${requestCount}`);
    return new FakeClientRequest(() => {
      queueMicrotask(() => {
        const response = new PassThrough() as PassThrough & {
          statusCode: number;
        };
        response.statusCode = responseConfig.statusCode ?? 200;
        callback?.(response as unknown as IncomingMessage);
        response.end(responseConfig.body);
      });
    }) as unknown as ReturnType<typeof https.request>;
  }) as typeof https.request;

  return {
    requestCount: () => requestCount,
    restore: () => {
      https.request = originalRequest;
    },
  };
};

const waitForResponse = async (response: FakeServerResponse): Promise<void> => {
  if (response.writableEnded) return;
  await new Promise<void>((resolve) => response.once("finish", resolve));
};

describe("empty upstream retry", () => {
  test("requestZenFull retries empty bodies and records them as 502 failures", async () => {
    const fakePool = createFakePool(["empty-1", "empty-2", "healthy"]);
    const upstream = installUpstreamResponses([
      { body: "" },
      { body: " \n\t" },
      { body: '{"choices":[{"message":{"content":"ok"}}]}' },
    ]);
    const metrics = new MetricsStore();

    try {
      const result = await requestZenFull(
        preparedRequest(fakePool.initialLease),
        fakePool.pool,
        metrics,
      );

      assert.equal(result.status, 200);
      assert.equal(result.data.choices[0].message.content, "ok");
      assert.equal(upstream.requestCount(), 3);
      assert.deepEqual(fakePool.acquiredAfterInitial, ["empty-2", "healthy"]);
      assert.deepEqual(fakePool.failures, [
        {
          id: "empty-1",
          error: EMPTY_UPSTREAM_RESPONSE_MESSAGE,
          statusCode: 502,
        },
        {
          id: "empty-2",
          error: EMPTY_UPSTREAM_RESPONSE_MESSAGE,
          statusCode: 502,
        },
      ]);
      assert.deepEqual(fakePool.successes, ["healthy"]);

      const upstreamMetrics = metrics.snapshot().upstream;
      assert.equal(upstreamMetrics.totalRequests, 3);
      assert.equal(upstreamMetrics.errorRequests, 2);
      assert.equal(upstreamMetrics.byStatus["502"], 2);
      assert.equal(upstreamMetrics.byStatus["200"], 1);
    } finally {
      upstream.restore();
    }
  });

  test("requestZenFull stops after three different empty proxies", async () => {
    const fakePool = createFakePool(["empty-1", "empty-2", "empty-3"]);
    const upstream = installUpstreamResponses([
      { body: "" },
      { body: "" },
      { body: "" },
    ]);

    try {
      await assert.rejects(
        requestZenFull(
          preparedRequest(fakePool.initialLease),
          fakePool.pool,
        ),
        new RegExp(EMPTY_UPSTREAM_RESPONSE_MESSAGE),
      );
      assert.equal(upstream.requestCount(), 3);
      assert.deepEqual(
        fakePool.failures.map(({ id, statusCode }) => ({ id, statusCode })),
        [
          { id: "empty-1", statusCode: 502 },
          { id: "empty-2", statusCode: 502 },
          { id: "empty-3", statusCode: 502 },
        ],
      );
      assert.deepEqual(fakePool.successes, []);
    } finally {
      upstream.restore();
    }
  });

  for (const stream of [false, true]) {
    test(`OpenAI ${stream ? "streaming" : "non-streaming"} passthrough retries an empty proxy`, async () => {
      const fakePool = createFakePool(["empty", "healthy"]);
      const successBody = stream
        ? 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
        : '{"choices":[{"message":{"content":"ok"}}]}';
      const upstream = installUpstreamResponses([
        { body: "" },
        { body: successBody },
      ]);
      const response = new FakeServerResponse();

      try {
        pipeZenOpenAIResponse(
          preparedRequest(fakePool.initialLease),
          stream,
          response as unknown as ServerResponse,
          fakePool.pool,
        );
        await waitForResponse(response);

        assert.equal(response.statusCode, 200);
        assert.equal(response.body(), successBody);
        assert.equal(upstream.requestCount(), 2);
        assert.deepEqual(fakePool.failures, [
          {
            id: "empty",
            error: EMPTY_UPSTREAM_RESPONSE_MESSAGE,
            statusCode: 502,
          },
        ]);
        assert.deepEqual(fakePool.successes, ["healthy"]);
      } finally {
        upstream.restore();
      }
    });
  }

  test("OpenAI passthrough returns the empty response error after three attempts", async () => {
    const fakePool = createFakePool(["empty-1", "empty-2", "empty-3"]);
    const upstream = installUpstreamResponses([
      { body: "" },
      { body: "" },
      { body: "" },
    ]);
    const response = new FakeServerResponse();

    try {
      pipeZenOpenAIResponse(
        preparedRequest(fakePool.initialLease),
        false,
        response as unknown as ServerResponse,
        fakePool.pool,
      );
      await waitForResponse(response);

      assert.equal(response.statusCode, 502);
      assert.equal(
        JSON.parse(response.body()).error.message,
        EMPTY_UPSTREAM_RESPONSE_MESSAGE,
      );
      assert.equal(upstream.requestCount(), 3);
      assert.equal(fakePool.failures.length, 3);
      assert.deepEqual(fakePool.successes, []);
    } finally {
      upstream.restore();
    }
  });

  const transformedStreams: Array<{
    name: string;
    successBody: string;
    pipe: (
      prepared: ZenPreparedRequest,
      response: ServerResponse,
      pool: ProxyPoolStore,
      maxProxyAttempts?: number,
    ) => void;
  }> = [
    {
      name: "Anthropic streaming response",
      successBody:
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
      pipe: (prepared, response, pool, maxProxyAttempts) =>
        pipeZenAsAnthropic(prepared, "test-model", response, 10, pool, undefined, maxProxyAttempts),
    },
    {
      name: "Anthropic SSE to OpenAI conversion",
      successBody:
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      pipe: (prepared, response, pool, maxProxyAttempts) =>
        pipeAnthropicSseAsOpenAI(
          prepared,
          "test-model",
          response,
          pool,
          undefined,
          maxProxyAttempts,
        ),
    },
    {
      name: "think-tag stream conversion",
      successBody:
        'data: {"choices":[{"delta":{"content":"<think>why</think>ok"}}]}\n\n' +
        "data: [DONE]\n\n",
      pipe: (prepared, response, pool, maxProxyAttempts) =>
        pipeOpenAiStreamStrippingThink(
          prepared,
          "test-model",
          response,
          pool,
          undefined,
          maxProxyAttempts,
        ),
    },
  ];

  for (const scenario of transformedStreams) {
    test(`${scenario.name} retries an empty proxy`, async () => {
      const fakePool = createFakePool(["empty", "healthy"]);
      const upstream = installUpstreamResponses([
        { body: "" },
        { body: scenario.successBody },
      ]);
      const response = new FakeServerResponse();

      try {
        scenario.pipe(
          preparedRequest(fakePool.initialLease),
          response as unknown as ServerResponse,
          fakePool.pool,
        );
        await waitForResponse(response);

        assert.equal(response.statusCode, 200);
        assert.match(response.body(), /ok/);
        assert.equal(upstream.requestCount(), 2);
        assert.deepEqual(fakePool.failures, [
          {
            id: "empty",
            error: EMPTY_UPSTREAM_RESPONSE_MESSAGE,
            statusCode: 502,
          },
        ]);
        assert.deepEqual(fakePool.successes, ["healthy"]);
      } finally {
        upstream.restore();
      }
    });
  }

  const fiftyProxyIds = Array.from(
    { length: 51 },
    (_, index) => `proxy-${index + 1}`,
  );

  for (const scenario of transformedStreams) {
    test(`${scenario.name} can use the configured 50 distinct proxy attempts`, async () => {
      const fakePool = createFakePool(fiftyProxyIds);
      const upstream = installUpstreamResponses([
        ...Array.from({ length: 49 }, () => ({ body: "" })),
        { body: scenario.successBody },
      ]);
      const response = new FakeServerResponse();
      try {
        scenario.pipe(
          preparedRequest(fakePool.initialLease),
          response as unknown as ServerResponse,
          fakePool.pool,
          50,
        );
        await waitForResponse(response);
        assert.equal(upstream.requestCount(), 50);
        assert.equal(new Set([fiftyProxyIds[0], ...fakePool.acquiredAfterInitial]).size, 50);
      } finally {
        upstream.restore();
      }
    });
  }

  test("OpenAI passthrough can use the configured 50 distinct proxy attempts", async () => {
    const fakePool = createFakePool(fiftyProxyIds);
    const upstream = installUpstreamResponses([
      ...Array.from({ length: 49 }, () => ({ body: "" })),
      { body: '{"choices":[{"message":{"content":"ok"}}]}' },
    ]);
    const response = new FakeServerResponse();
    try {
      pipeZenOpenAIResponse(
        preparedRequest(fakePool.initialLease), false,
        response as unknown as ServerResponse, fakePool.pool, undefined, 50,
      );
      await waitForResponse(response);
      assert.equal(upstream.requestCount(), 50);
      assert.equal(new Set([fiftyProxyIds[0], ...fakePool.acquiredAfterInitial]).size, 50);
    } finally {
      upstream.restore();
    }
  });

  test("requestZenFull can use the configured 50 distinct proxy attempts", async () => {
    const fakePool = createFakePool(fiftyProxyIds);
    const upstream = installUpstreamResponses([
      ...Array.from({ length: 49 }, () => ({ body: "" })),
      { body: '{"choices":[{"message":{"content":"ok"}}]}' },
    ]);
    try {
      const result = await requestZenFull(
        preparedRequest(fakePool.initialLease),
        fakePool.pool,
        undefined,
        50,
      );
      assert.equal(result.status, 200);
      assert.equal(upstream.requestCount(), 50);
      assert.equal(new Set([fiftyProxyIds[0], ...fakePool.acquiredAfterInitial]).size, 50);
      assert.deepEqual(fakePool.acquiredAfterInitial, fiftyProxyIds.slice(1, 50));
    } finally {
      upstream.restore();
    }
  });

  test("requestZenFull fails at the configured attempt limit", async () => {
    const fakePool = createFakePool(fiftyProxyIds);
    const upstream = installUpstreamResponses(
      Array.from({ length: 50 }, () => ({ body: "" })),
    );
    try {
      await assert.rejects(
        requestZenFull(preparedRequest(fakePool.initialLease), fakePool.pool, undefined, 50),
        new RegExp(EMPTY_UPSTREAM_RESPONSE_MESSAGE),
      );
      assert.equal(upstream.requestCount(), 50);
      assert.equal(new Set([fiftyProxyIds[0], ...fakePool.acquiredAfterInitial]).size, 50);
    } finally {
      upstream.restore();
    }
  });

  test("requestZenFull stops when fewer proxies are available than the configured limit", async () => {
    const fakePool = createFakePool(["only-1", "only-2"]);
    const upstream = installUpstreamResponses([{ body: "" }, { body: "" }]);
    try {
      await assert.rejects(
        requestZenFull(preparedRequest(fakePool.initialLease), fakePool.pool, undefined, 50),
        new RegExp(EMPTY_UPSTREAM_RESPONSE_MESSAGE),
      );
      assert.equal(upstream.requestCount(), 2);
      assert.deepEqual(fakePool.acquiredAfterInitial, ["only-2"]);
    } finally {
      upstream.restore();
    }
  });

  test("requestZenFull does not retry without a proxy pool", async () => {
    const upstream = installUpstreamResponses([{ body: "" }]);
    try {
      await assert.rejects(
        requestZenFull({ body: "{}", options: {} }, undefined, undefined, 50),
        new RegExp(EMPTY_UPSTREAM_RESPONSE_MESSAGE),
      );
      assert.equal(upstream.requestCount(), 1);
    } finally {
      upstream.restore();
    }
  });

  test("OpenAI passthrough does not retry after response headers are sent", async () => {
    const fakePool = createFakePool(["started", "unused"]);
    const upstream = installUpstreamResponses([{ body: "partial response" }]);
    const response = new FakeServerResponse();
    try {
      pipeZenOpenAIResponse(
        preparedRequest(fakePool.initialLease),
        false,
        response as unknown as ServerResponse,
        fakePool.pool,
        undefined,
        50,
      );
      await waitForResponse(response);
      assert.equal(response.headersSent, true);
      assert.equal(upstream.requestCount(), 1);
      assert.deepEqual(fakePool.acquiredAfterInitial, []);
    } finally {
      upstream.restore();
    }
  });
});
