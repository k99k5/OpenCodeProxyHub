import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { ProxyPoolStore, type ProxyNode } from "../src/proxy/proxyPool.js";
import { ProxySyncService, SCDN_PROXY_SOURCE } from "../src/proxy/proxySync.js";
import { SettingsStore } from "../src/settings/settingsStore.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const createPool = (probe?: (node: ProxyNode) => Promise<void>) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oph-proxy-test-"));
  tempDirs.push(directory);
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  settings.load();
  const pool = new ProxyPoolStore(path.join(directory, "proxies.json"), settings, { probe });
  pool.load();
  return { pool, settings };
};

describe("ProxyPoolStore maintenance", () => {
  test("source sync replaces only stale nodes from the same source", () => {
    const { pool } = createPool();
    const manual = pool.create({ name: "manual", url: "http://manual.example:8080" });

    const first = pool.syncSource("provider", ["10.0.0.1:80", "10.0.0.2:80"]);
    assert.deepEqual(
      { created: first.created, retained: first.retained, removed: first.removed, total: first.total },
      { created: 2, retained: 0, removed: 0, total: 3 },
    );
    const retainedId = pool.list().find((node) => node.url === "http://10.0.0.2:80")?.id;

    const second = pool.syncSource("provider", ["10.0.0.2:80", "10.0.0.3:80"]);
    assert.deepEqual(
      { created: second.created, retained: second.retained, removed: second.removed, total: second.total },
      { created: 1, retained: 1, removed: 1, total: 3 },
    );

    const nodes = pool.list();
    assert.equal(nodes.find((node) => node.id === manual.id)?.source, null);
    assert.equal(nodes.find((node) => node.url === "http://10.0.0.2:80")?.id, retainedId);
    assert.equal(nodes.find((node) => node.url === "http://10.0.0.3:80")?.source, "provider");
    assert.equal(nodes.some((node) => node.url === "http://10.0.0.1:80"), false);
  });

  test("cleanup probes every node and deletes only failed unchanged nodes", async () => {
    const { pool } = createPool(async (node) => {
      if (node.url.includes("dead.example")) throw new Error("connection refused");
    });
    pool.create({ name: "healthy", url: "http://healthy.example:8080" });
    pool.create({ name: "dead", url: "http://dead.example:8080" });

    const result = await pool.cleanupInvalid(2);

    assert.equal(result.tested, 2);
    assert.equal(result.deleted, 1);
    assert.equal(result.remaining, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.name, "dead");
    assert.deepEqual(pool.list().map((node) => node.name), ["healthy"]);
  });
});

describe("ProxySyncService", () => {
  test("fetches five 20-item batches and synchronizes 100 unique proxies", async () => {
    const { pool, settings } = createPool();
    let calls = 0;
    const fetchImpl = async () => {
      const batch = calls;
      calls += 1;
      const proxies = Array.from({ length: 20 }, (_, index) => `10.${batch}.${index}.1:8080`);
      return new Response(JSON.stringify({ code: 200, message: "success", data: { proxies, count: 20 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const service = new ProxySyncService(pool, settings, {
      fetchImpl: fetchImpl as typeof fetch,
      targetCount: 100,
      batchSize: 20,
      maxBatches: 10,
    });

    const result = await service.syncNow();

    assert.equal(calls, 5);
    assert.equal(result.batches, 5);
    assert.equal(result.received, 100);
    assert.equal(result.created, 100);
    assert.equal(pool.list().filter((node) => node.source === SCDN_PROXY_SOURCE).length, 100);
  });

  test("does not replace the current source set when unique addresses are insufficient", async () => {
    const { pool, settings } = createPool();
    pool.syncSource(SCDN_PROXY_SOURCE, ["192.0.2.1:8080"]);
    const repeated = Array.from({ length: 20 }, (_, index) => `198.51.100.${index + 1}:8080`);
    const fetchImpl = async () => new Response(
      JSON.stringify({ code: 200, message: "success", data: { proxies: repeated, count: 20 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const service = new ProxySyncService(pool, settings, {
      fetchImpl: fetchImpl as typeof fetch,
      targetCount: 25,
      batchSize: 20,
      maxBatches: 2,
    });

    await assert.rejects(() => service.syncNow(), /only 20 unique addresses/);
    assert.deepEqual(
      pool.list().filter((node) => node.source === SCDN_PROXY_SOURCE).map((node) => node.url),
      ["http://192.0.2.1:8080"],
    );
  });
});
