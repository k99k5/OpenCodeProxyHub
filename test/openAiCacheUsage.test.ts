import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import {
  applyOpenAiCacheUsageFallback,
  OpenAiCacheUsageSseRewriter,
  rewriteOpenAiJsonCacheUsage,
} from "../src/converters/openAiCacheUsage.js";
import {
  pipeZenOpenAIResponse,
  type ZenPreparedRequest,
} from "../src/providers/zenClient.js";
import { pipeOpenAiStreamStrippingThink } from "../src/converters/openAiThinkTagToReasoning.js";

class FakeClientRequest extends EventEmitter {
  write(): boolean {
    return true;
  }

  end(): this {
    return this;
  }

  destroy(): this {
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
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    queueMicrotask(() => this.emit("finish"));
    return this;
  }

  body(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

const waitForResponse = async (response: FakeServerResponse): Promise<void> => {
  if (response.writableEnded) return;
  await new Promise<void>((resolve) => response.once("finish", resolve));
};

const withUpstreamChunks = async (
  chunks: string[],
  run: () => Promise<void>,
): Promise<void> => {
  const originalRequest = https.request;
  https.request = ((
    _options: https.RequestOptions,
    callback?: (response: IncomingMessage) => void,
  ) => {
    const response = new PassThrough() as PassThrough & { statusCode: number };
    response.statusCode = 200;
    callback?.(response as unknown as IncomingMessage);
    queueMicrotask(() => {
      for (const chunk of chunks) response.write(chunk);
      response.end();
    });
    return new FakeClientRequest() as unknown as ReturnType<
      typeof https.request
    >;
  }) as typeof https.request;

  try {
    await run();
  } finally {
    https.request = originalRequest;
  }
};

const preparedRequest: ZenPreparedRequest = {
  body: "{}",
  options: {},
};

describe("OpenAI cache usage fallback", () => {
  test("keeps a positive cached token count returned by upstream", () => {
    const payload = {
      usage: {
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 250, audio_tokens: 12 },
      },
    };

    assert.equal(applyOpenAiCacheUsageFallback(payload), false);
    assert.deepEqual(payload.usage.prompt_tokens_details, {
      cached_tokens: 250,
      audio_tokens: 12,
    });
  });

  test("replaces an upstream zero with 90% of prompt tokens", () => {
    const payload = {
      usage: {
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 12 },
      },
    };

    assert.equal(applyOpenAiCacheUsageFallback(payload), true);
    assert.deepEqual(payload.usage.prompt_tokens_details, {
      cached_tokens: 900,
      audio_tokens: 12,
    });
  });

  test("adds cache details when upstream omits them", () => {
    const raw = JSON.stringify({
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
    });

    assert.equal(
      JSON.parse(rewriteOpenAiJsonCacheUsage(raw)).usage.prompt_tokens_details
        .cached_tokens,
      900,
    );
  });

  test("leaves payloads without prompt token usage unchanged", () => {
    const raw = '{"choices":[{"message":{"content":"ok"}}]}';

    assert.equal(rewriteOpenAiJsonCacheUsage(raw), raw);
  });

  test("rewrites usage in SSE blocks split across chunks", () => {
    const rewriter = new OpenAiCacheUsageSseRewriter();
    const first = rewriter.push(
      'data: {"choices":[],"usage":{"prompt_tokens":10',
    );
    const second = rewriter.push(
      '00,"prompt_tokens_details":{"cached_tokens":0}}}\n\n' +
        "data: [DONE]\n\n",
    );

    assert.equal(first, "");
    assert.equal(
      second,
      'data: {"choices":[],"usage":{"prompt_tokens":1000,' +
        '"prompt_tokens_details":{"cached_tokens":900}}}\n\n' +
        "data: [DONE]\n\n",
    );
  });

  test("splits final usage into a standalone chunk before DONE", () => {
    const rewriter = new OpenAiCacheUsageSseRewriter();
    const finalChunk = {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 123,
      model: "deepseek-v4-flash",
      system_fingerprint: "fp_test",
      choices: [
        {
          index: 0,
          delta: { content: "", reasoning_content: null },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 130,
        completion_tokens: 77,
        total_tokens: 207,
        prompt_tokens_details: { cached_tokens: 128 },
      },
    };

    const output =
      rewriter.push(`data: ${JSON.stringify(finalChunk)}\n\n`) +
      rewriter.push(
        "data: [DONE]\n\n" + 'data: {"choices":[],"cost":"0"}\n\n',
      ) +
      rewriter.flush();
    const blocks = output.trim().split("\n\n");

    assert.equal(blocks.length, 3);
    const finishPayload = JSON.parse(blocks[0]!.slice(6));
    const usagePayload = JSON.parse(blocks[1]!.slice(6));
    assert.deepEqual(finishPayload.choices, finalChunk.choices);
    assert.equal(finishPayload.usage, null);
    assert.deepEqual(usagePayload.choices, []);
    assert.deepEqual(usagePayload.usage, finalChunk.usage);
    assert.equal(usagePayload.id, finalChunk.id);
    assert.equal(usagePayload.model, finalChunk.model);
    assert.equal(blocks[2], "data: [DONE]");
    assert.doesNotMatch(output, /"cost"/);
  });

  test("flushes standalone usage when upstream omits DONE", () => {
    const rewriter = new OpenAiCacheUsageSseRewriter();
    const output =
      rewriter.push(
        'data: {"choices":[{"finish_reason":"stop"}],"usage":' +
          '{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":0}}}\n\n',
      ) + rewriter.flush();
    const blocks = output.trim().split("\n\n");

    assert.equal(blocks.length, 2);
    assert.equal(JSON.parse(blocks[0]!.slice(6)).usage, null);
    assert.deepEqual(JSON.parse(blocks[1]!.slice(6)), {
      choices: [],
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 90 },
      },
    });
  });

  test("preserves UTF-8 characters split across byte chunks", () => {
    const rewriter = new OpenAiCacheUsageSseRewriter();
    const source =
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n' +
      "data: [DONE]\n\n";
    const bytes = Buffer.from(source);
    const splitAt = bytes.indexOf(Buffer.from("你")) + 1;
    const output =
      rewriter.push(bytes.subarray(0, splitAt)) +
      rewriter.push(bytes.subarray(splitAt)) +
      rewriter.flush();

    assert.equal(output, source);
  });

  test("rewrites non-streaming OpenAI passthrough responses", async () => {
    await withUpstreamChunks(
      [
        '{"choices":[{"message":{"content":"ok"}}],"usage":',
        '{"prompt_tokens":1000,"completion_tokens":10}}',
      ],
      async () => {
        const response = new FakeServerResponse();
        pipeZenOpenAIResponse(
          preparedRequest,
          false,
          response as unknown as ServerResponse,
        );
        await waitForResponse(response);

        assert.equal(
          JSON.parse(response.body()).usage.prompt_tokens_details.cached_tokens,
          900,
        );
      },
    );
  });

  test("rewrites streaming OpenAI passthrough responses", async () => {
    await withUpstreamChunks(
      [
        'data: {"id":"chatcmpl_test","choices":[{"delta":{},',
        '"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,' +
          '"prompt_tokens_details":{"cached_tokens":0}}}\n\n',
        "data: [DONE]\n\n",
        'data: {"choices":[],"cost":"0"}\n\n',
      ],
      async () => {
        const response = new FakeServerResponse();
        pipeZenOpenAIResponse(
          preparedRequest,
          true,
          response as unknown as ServerResponse,
        );
        await waitForResponse(response);

        const blocks = response.body().trim().split("\n\n");
        assert.equal(blocks.length, 3);
        assert.equal(JSON.parse(blocks[0]!.slice(6)).usage, null);
        const usagePayload = JSON.parse(blocks[1]!.slice(6));
        assert.deepEqual(usagePayload.choices, []);
        assert.equal(
          usagePayload.usage.prompt_tokens_details.cached_tokens,
          900,
        );
        assert.equal(blocks[2], "data: [DONE]");
        assert.doesNotMatch(response.body(), /"cost"/);
      },
    );
  });

  test("normalizes transformed OpenAI streams before DONE", async () => {
    await withUpstreamChunks(
      [
        'data: {"choices":[{"delta":{"content":"<think>why</think>ok"},' +
          '"finish_reason":null}],"usage":null}\n\n',
        'data: {"id":"chatcmpl_test","choices":[{"delta":{},' +
          '"finish_reason":"stop"}],"usage":{"prompt_tokens":100,' +
          '"prompt_tokens_details":{"cached_tokens":0}}}\n\n',
        "data: [DONE]\n\n",
        'data: {"choices":[],"cost":"0"}\n\n',
      ],
      async () => {
        const response = new FakeServerResponse();
        pipeOpenAiStreamStrippingThink(
          preparedRequest,
          "test-model",
          response as unknown as ServerResponse,
        );
        await waitForResponse(response);

        const blocks = response.body().trim().split("\n\n");
        assert.equal(blocks.length, 4);
        const contentPayload = JSON.parse(blocks[0]!.slice(6));
        assert.equal(contentPayload.choices[0].delta.reasoning_content, "why");
        assert.equal(contentPayload.choices[0].delta.content, "ok");
        assert.equal(JSON.parse(blocks[1]!.slice(6)).usage, null);
        const usagePayload = JSON.parse(blocks[2]!.slice(6));
        assert.deepEqual(usagePayload.choices, []);
        assert.equal(
          usagePayload.usage.prompt_tokens_details.cached_tokens,
          90,
        );
        assert.equal(blocks[3], "data: [DONE]");
        assert.doesNotMatch(response.body(), /"cost"/);
      },
    );
  });
});
