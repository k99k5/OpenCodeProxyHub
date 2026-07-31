import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { DEFAULT_PROXY_CONNECTIVITY_CHECK_URL, ProxyPoolStore, type ProxyNode } from "../src/proxy/proxyPool.js";
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
  test("uses a neutral public connectivity endpoint by default", () => {
    assert.equal(DEFAULT_PROXY_CONNECTIVITY_CHECK_URL, "https://cp.cloudflare.com/generate_204");
    assert.equal(DEFAULT_PROXY_CONNECTIVITY_CHECK_URL.includes("opencode.ai"), false);
  });

  test("uses a configurable five-second proxy connection timeout", () => {
    const { settings } = createPool();
    assert.equal(settings.get().proxyConnectTimeoutMs, 5000);
    assert.equal(
      settings.update({ proxyConnectTimeoutMs: 3000 }).proxyConnectTimeoutMs,
      3000,
    );
    assert.throws(
      () => settings.update({ proxyConnectTimeoutMs: 999 }),
      /between 1000 and 60000/,
    );
    assert.throws(
      () => settings.update({ proxyConnectTimeoutMs: 60001 }),
      /between 1000 and 60000/,
    );
  });

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

  test("cleanup probes every enabled node and deletes only failed unchanged nodes", async () => {
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
    assert.deepEqual(
      {
        running: pool.getCleanupQueueStatus().running,
        total: pool.getCleanupQueueStatus().total,
        completed: pool.getCleanupQueueStatus().completed,
        succeeded: pool.getCleanupQueueStatus().succeeded,
        failed: pool.getCleanupQueueStatus().failed,
        deleted: pool.getCleanupQueueStatus().deleted,
      },
      { running: false, total: 2, completed: 2, succeeded: 1, failed: 1, deleted: 1 },
    );
  });

  test("cleanup deletes disabled nodes without probing them", async () => {
    const probed: string[] = [];
    const { pool } = createPool(async (node) => {
      probed.push(node.name);
    });
    pool.create({ name: "healthy", url: "http://healthy.example:8080" });
    pool.create({
      name: "disabled",
      url: "http://disabled.example:8080",
      enabled: false,
    });

    const result = await pool.cleanupInvalid(2);

    assert.deepEqual(probed, ["healthy"]);
    assert.deepEqual(result, {
      tested: 1,
      deleted: 1,
      remaining: 1,
      failures: [],
    });
    assert.deepEqual(pool.list().map((node) => node.name), ["healthy"]);
    assert.deepEqual(
      {
        total: pool.getCleanupQueueStatus().total,
        completed: pool.getCleanupQueueStatus().completed,
        succeeded: pool.getCleanupQueueStatus().succeeded,
        failed: pool.getCleanupQueueStatus().failed,
        deleted: pool.getCleanupQueueStatus().deleted,
      },
      { total: 1, completed: 1, succeeded: 1, failed: 0, deleted: 1 },
    );
  });

  test("cleanup completes without workers when every node is disabled", async () => {
    const { pool } = createPool(async () => {
      throw new Error("disabled nodes must not be probed");
    });
    pool.create({
      name: "disabled-1",
      url: "http://disabled-1.example:8080",
      enabled: false,
    });
    pool.create({
      name: "disabled-2",
      url: "http://disabled-2.example:8080",
      enabled: false,
    });

    const result = await pool.cleanupInvalid(2);
    const status = pool.getCleanupQueueStatus();

    assert.deepEqual(result, {
      tested: 0,
      deleted: 2,
      remaining: 0,
      failures: [],
    });
    assert.deepEqual(
      {
        running: status.running,
        total: status.total,
        queued: status.queued,
        completed: status.completed,
        deleted: status.deleted,
        concurrency: status.concurrency,
      },
      {
        running: false,
        total: 0,
        queued: 0,
        completed: 0,
        deleted: 2,
        concurrency: 0,
      },
    );
    assert.ok(status.completedAt);
  });

  test("reports live bounded-worker queue status", async () => {
    let releaseProbe: (() => void) | undefined;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const { pool } = createPool(async () => probeGate);
    pool.import(["queue-1.example:8080", "queue-2.example:8080", "queue-3.example:8080"]);

    const cleanup = pool.cleanupInvalid(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      {
        running: pool.getCleanupQueueStatus().running,
        total: pool.getCleanupQueueStatus().total,
        queued: pool.getCleanupQueueStatus().queued,
        checking: pool.getCleanupQueueStatus().checking,
        completed: pool.getCleanupQueueStatus().completed,
        concurrency: pool.getCleanupQueueStatus().concurrency,
      },
      { running: true, total: 3, queued: 2, checking: 1, completed: 0, concurrency: 1 },
    );

    releaseProbe?.();
    await cleanup;
    assert.equal(pool.getCleanupQueueStatus().completed, 3);
  });
});

describe("ProxySyncService", () => {
  test("fetches five 20-item batches and synchronizes 100 unique proxies", async () => {
    const { pool, settings } = createPool(async () => undefined);
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
    assert.equal(result.cleanup.tested, 100);
    assert.equal(result.cleanup.deleted, 0);
    assert.equal(pool.list().filter((node) => node.source === SCDN_PROXY_SOURCE).length, 100);
  });

  test("does not replace the current source set when unique addresses are insufficient", async () => {
    const { pool, settings } = createPool(async () => undefined);
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

  test("queues enabled provider and user-imported nodes after sync and directly deletes disabled nodes", async () => {
    let activeChecks = 0;
    let maxActiveChecks = 0;
    const checkedUrls: string[] = [];
    const { pool, settings } = createPool(async (node) => {
      checkedUrls.push(node.url);
      activeChecks += 1;
      maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (node.url === "http://manual-dead.example:8080" || node.url === "http://10.0.0.2:8080") {
          throw new Error("public internet unavailable");
        }
      } finally {
        activeChecks -= 1;
      }
    });
    const imported = pool.import([
      "manual-healthy.example:8080",
      "manual-dead.example:8080",
      "manual-disabled.example:8080",
    ]);
    const disabled = imported.created.find(
      (node) => node.url === "http://manual-disabled.example:8080",
    );
    assert.ok(disabled);
    pool.update(disabled.id, { enabled: false });

    const fetchImpl = async () => new Response(
      JSON.stringify({
        code: 200,
        message: "success",
        data: {
          proxies: [
            "10.0.0.1:8080",
            "10.0.0.2:8080",
            "10.0.0.3:8080",
            "10.0.0.4:8080",
          ],
          count: 4,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const service = new ProxySyncService(pool, settings, {
      fetchImpl: fetchImpl as typeof fetch,
      targetCount: 4,
      batchSize: 4,
      maxBatches: 1,
      cleanupConcurrency: 2,
    });

    const result = await service.syncNow();

    assert.equal(result.cleanup.tested, 6);
    assert.equal(result.cleanup.deleted, 3);
    assert.equal(result.cleanup.remaining, 4);
    assert.equal(result.total, 4);
    assert.equal(maxActiveChecks, 2);
    assert.equal(checkedUrls.includes("http://manual-disabled.example:8080"), false);
    assert.equal(pool.list().some((node) => node.url === "http://manual-healthy.example:8080"), true);
    assert.equal(pool.list().some((node) => node.url === "http://manual-dead.example:8080"), false);
    assert.equal(pool.list().some((node) => node.url === "http://manual-disabled.example:8080"), false);
    assert.equal(pool.list().some((node) => node.url === "http://10.0.0.2:8080"), false);
    assert.deepEqual(
      {
        total: service.getStatus().cleanupQueue.total,
        completed: service.getStatus().cleanupQueue.completed,
        concurrency: service.getStatus().cleanupQueue.concurrency,
      },
      { total: 6, completed: 6, concurrency: 2 },
    );
  });
});
