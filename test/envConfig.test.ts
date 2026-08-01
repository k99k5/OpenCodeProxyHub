import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  DEFAULT_MAX_PROXY_ATTEMPTS,
  MAX_MAX_PROXY_ATTEMPTS,
  loadConfig,
} from "../src/config/env.js";

const originalValue = process.env.MAX_PROXY_ATTEMPTS;

afterEach(() => {
  if (originalValue === undefined) delete process.env.MAX_PROXY_ATTEMPTS;
  else process.env.MAX_PROXY_ATTEMPTS = originalValue;
});

describe("MAX_PROXY_ATTEMPTS configuration", () => {
  test("defaults to three", () => {
    delete process.env.MAX_PROXY_ATTEMPTS;
    assert.equal(loadConfig().maxProxyAttempts, DEFAULT_MAX_PROXY_ATTEMPTS);
  });

  test("accepts the maximum value of 50", () => {
    process.env.MAX_PROXY_ATTEMPTS = String(MAX_MAX_PROXY_ATTEMPTS);
    assert.equal(loadConfig().maxProxyAttempts, 50);
  });

  for (const invalid of ["0", "-1", "51", "1.5", "not-a-number"]) {
    test(`rejects invalid value ${invalid}`, () => {
      process.env.MAX_PROXY_ATTEMPTS = invalid;
      assert.equal(loadConfig().maxProxyAttempts, DEFAULT_MAX_PROXY_ATTEMPTS);
    });
  }
});
