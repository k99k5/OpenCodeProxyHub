import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config/env.js";
import { prepareZenRequest } from "../src/providers/zenClient.js";

const prepare = (promptCacheKey?: string): Record<string, unknown> => {
  const prepared = prepareZenRequest(loadConfig(), {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    sessionId: "test-session",
    promptCacheKey,
  });

  return JSON.parse(prepared.body) as Record<string, unknown>;
};

describe("OpenAI prompt_cache_key forwarding", () => {
  test("preserves prompt_cache_key in the Zen request body", () => {
    const body = prepare("tenant-42:conversation-7");

    assert.equal(body.prompt_cache_key, "tenant-42:conversation-7");
  });

  test("omits prompt_cache_key when the client does not provide it", () => {
    const body = prepare();

    assert.equal("prompt_cache_key" in body, false);
  });
});
