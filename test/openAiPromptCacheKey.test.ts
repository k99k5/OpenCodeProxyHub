import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config/env.js";
import { prepareZenRequest } from "../src/providers/zenClient.js";

const prepare = (promptCacheKey?: string) => {
  const prepared = prepareZenRequest(loadConfig(), {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    sessionId: "test-session",
    promptCacheKey,
  });

  return {
    body: JSON.parse(prepared.body) as Record<string, unknown>,
    headers: prepared.options.headers as Record<string, string>,
  };
};

describe("OpenAI prompt_cache_key forwarding", () => {
  test("preserves prompt_cache_key in the Zen request body", () => {
    const { body } = prepare("tenant-42:conversation-7");

    assert.equal(body.prompt_cache_key, "tenant-42:conversation-7");
  });

  test("omits prompt_cache_key when the client does not provide it", () => {
    const { body } = prepare();

    assert.equal("prompt_cache_key" in body, false);
  });

  test("derives stable project and session headers from prompt_cache_key", () => {
    const first = prepare("tenant-42:conversation-7");
    const second = prepare("tenant-42:conversation-7");
    const hash =
      "0dd6c9241d8e4f7eacd56070a60cb71256fa31a3e386d663398698d4e9232ebd";

    assert.equal(first.headers["x-opencode-project"], `proj_${hash}`);
    assert.equal(first.headers["x-opencode-session"], `sess_${hash}`);
    assert.equal(second.headers["x-opencode-project"], `proj_${hash}`);
    assert.equal(second.headers["x-opencode-session"], `sess_${hash}`);
    assert.match(first.headers["x-opencode-request"], /^msg_/);
    assert.notEqual(
      first.headers["x-opencode-request"],
      second.headers["x-opencode-request"],
    );
  });

  test("keeps existing header fallbacks without prompt_cache_key", () => {
    const { headers } = prepare();

    assert.equal(headers["x-opencode-project"], "global");
    assert.equal(headers["x-opencode-session"], "test-session");
    assert.match(headers["x-opencode-request"], /^msg_/);
  });
});
