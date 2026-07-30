import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import net from "node:net";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  armProxyConnectTimeout,
  ProxyConnectTimeoutError,
  type ProxyConnectionControl,
} from "../src/proxy/connectTimeout.js";
import { HttpPreProxyToHttpAgent } from "../src/proxy/chainedAgent.js";
import type {
  ProxyLease,
  ProxyNode,
  ProxyPoolStore,
} from "../src/proxy/proxyPool.js";
import {
  requestZenFull,
  type ZenPreparedRequest,
} from "../src/providers/zenClient.js";
import { ConnectTimeoutSocksProxyAgent } from "../src/proxy/socksConnectAgent.js";

const wait = (durationMs: number) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

class FakeClientRequest extends EventEmitter {
  destroyed = false;

  constructor(
    private readonly onEnd: (request: FakeClientRequest) => void = () => undefined,
  ) {
    super();
  }

  write(): boolean {
    return true;
  }

  end(): this {
    this.onEnd(this);
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

const proxyNode = (id: string): ProxyNode => ({
  id,
  name: id,
  type: "http",
  url: `http://${id}.example:8080`,
  source: null,
  enabled: true,
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

describe("proxy connection timeout", () => {
  test("aborts the underlying HTTP proxy socket when CONNECT stalls", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", () => undefined);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const controller = new AbortController();
    const request = https.get("https://example.invalid/", {
      agent: new HttpsProxyAgent(`http://127.0.0.1:${address.port}`, {
        signal: controller.signal,
      }),
    });
    const armed = armProxyConnectTimeout(request, {
      timeoutMs: 25,
      abort: (error) => controller.abort(error),
    });

    try {
      const error = await new Promise<Error>((resolve) => {
        request.once("error", resolve);
      });
      assert.equal(armed.didTimeout(), true);
      assert.match(error.message, /Proxy connect timeout|aborted/i);
      await wait(15);
      assert.equal(sockets.size, 0);
    } finally {
      request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("keeps timing after HTTP CONNECT until target TLS is established", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const controller = new AbortController();
    const request = https.get("https://example.invalid/", {
      agent: new HttpsProxyAgent(`http://127.0.0.1:${address.port}`, {
        signal: controller.signal,
      }),
    });
    const armed = armProxyConnectTimeout(request, {
      timeoutMs: 25,
      abort: (error) => controller.abort(error),
    });

    try {
      await new Promise<Error>((resolve) => {
        request.once("error", resolve);
      });
      assert.equal(armed.didTimeout(), true);
      await wait(15);
      assert.equal(sockets.size, 0);
    } finally {
      request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("times out a stalled SOCKS5 handshake and closes its socket", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", () => undefined);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const controller = new AbortController();
    const request = https.get("https://127.0.0.1/", {
      agent: new ConnectTimeoutSocksProxyAgent(
        `socks5://127.0.0.1:${address.port}`,
        25,
        controller.signal,
      ),
      rejectUnauthorized: false,
    });
    const armed = armProxyConnectTimeout(request, {
      timeoutMs: 25,
      abort: (error) => controller.abort(error),
    });

    try {
      await new Promise<Error>((resolve) => {
        request.once("error", resolve);
      });
      assert.equal(armed.didTimeout(), true);
      await wait(15);
      assert.equal(sockets.size, 0);
    } finally {
      request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("aborts a stalled chained pre-proxy handshake", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", () => undefined);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const controller = new AbortController();
    const request = https.get("https://127.0.0.1/", {
      agent: new HttpPreProxyToHttpAgent(
        `http://127.0.0.1:${address.port}`,
        "http://127.0.0.1:8080",
        controller.signal,
      ),
      rejectUnauthorized: false,
    });
    const armed = armProxyConnectTimeout(request, {
      timeoutMs: 25,
      abort: (error) => controller.abort(error),
    });

    try {
      await new Promise<Error>((resolve) => {
        request.once("error", resolve);
      });
      assert.equal(armed.didTimeout(), true);
      await wait(15);
      assert.equal(sockets.size, 0);
    } finally {
      request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("does not retain the SOCKS5 connect timeout as an idle timeout", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.once("data", () => {
        socket.write(Buffer.from([0x05, 0x00]));
        socket.once("data", () => {
          socket.write(Buffer.from([
            0x05, 0x00, 0x00, 0x01,
            127, 0, 0, 1,
            0, 0,
          ]));
        });
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const controller = new AbortController();
    const agent = new ConnectTimeoutSocksProxyAgent(
      `socks5://127.0.0.1:${address.port}`,
      25,
      controller.signal,
    );
    const request = new FakeClientRequest();

    try {
      const socket = await agent.connect(request as never, {
        host: "127.0.0.1",
        port: 443,
        secureEndpoint: false,
      } as never);
      await wait(40);
      assert.equal(socket.destroyed, false);
      socket.destroy();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("includes local SOCKS5 DNS resolution in the connection budget", async () => {
    const controller = new AbortController();
    const agent = new ConnectTimeoutSocksProxyAgent(
      "socks5://127.0.0.1:1080",
      25,
      controller.signal,
    );

    await assert.rejects(
      () => agent.connect(new FakeClientRequest() as never, {
        host: "slow-dns.example",
        port: 443,
        secureEndpoint: false,
        lookup: () => undefined,
      } as never),
      /timed out during DNS lookup/,
    );
  });

  test("keeps the timer active until the target TLS handshake completes", async () => {
    const request = new FakeClientRequest();
    const aborts: Error[] = [];
    const control: ProxyConnectionControl = {
      timeoutMs: 25,
      abort: (error) => aborts.push(error),
    };
    armProxyConnectTimeout(request as never, control);

    const socket = new EventEmitter() as EventEmitter & {
      encrypted: boolean;
      secureConnecting: boolean;
    };
    socket.encrypted = true;
    socket.secureConnecting = true;
    request.emit("socket", socket);

    await wait(10);
    assert.equal(aborts.length, 0);

    socket.secureConnecting = false;
    socket.emit("secureConnect");
    await wait(30);

    assert.equal(aborts.length, 0);
    assert.equal(request.destroyed, false);
  });

  test("times out a stalled proxy and retries with a different proxy", async () => {
    const originalRequest = https.request;
    const failed: Array<{ id: string; error: string; statusCode?: number }> = [];
    const succeeded: string[] = [];
    const aborts = new Map<string, Error[]>();
    let requestCount = 0;

    const lease = (id: string): ProxyLease => {
      const proxyAborts: Error[] = [];
      aborts.set(id, proxyAborts);
      return {
        node: proxyNode(id),
        agent: {} as https.Agent,
        connection: {
          timeoutMs: 25,
          abort: (error) => proxyAborts.push(error),
        },
      };
    };
    const firstLease = lease("stalled");
    const secondLease = lease("healthy");

    const pool = {
      acquire(excludedIds: ReadonlySet<string>) {
        assert.equal(excludedIds.has("stalled"), true);
        return secondLease;
      },
      markFailure(id: string, error: string, options: { statusCode?: number }) {
        failed.push({ id, error, statusCode: options.statusCode });
      },
      markSuccess(id: string) {
        succeeded.push(id);
      },
    } as unknown as ProxyPoolStore;

    https.request = ((_, callback) => {
      requestCount += 1;
      if (requestCount === 1) {
        return new FakeClientRequest() as never;
      }

      return new FakeClientRequest((request) => {
        queueMicrotask(() => {
          request.emit("socket", new net.Socket());
          const response = new PassThrough() as PassThrough & {
            statusCode: number;
          };
          response.statusCode = 200;
          callback?.(response as never);
          response.end('{"ok":true}');
        });
      }) as never;
    }) as typeof https.request;

    const prepared: ZenPreparedRequest = {
      body: "{}",
      options: {},
      lease: firstLease,
    };

    try {
      const response = await requestZenFull(prepared, pool);
      await wait(35);

      assert.equal(response.status, 200);
      assert.deepEqual(response.data, { ok: true });
      assert.equal(requestCount, 2);
      assert.deepEqual(failed, [{
        id: "stalled",
        error: "Proxy connect timeout after 25ms",
        statusCode: 504,
      }]);
      assert.deepEqual(succeeded, ["healthy"]);
      assert.equal(aborts.get("stalled")?.[0] instanceof ProxyConnectTimeoutError, true);
      assert.equal(aborts.get("healthy")?.length, 0);
    } finally {
      https.request = originalRequest;
    }
  });
});
