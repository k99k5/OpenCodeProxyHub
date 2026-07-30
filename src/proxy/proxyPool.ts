import crypto from "node:crypto";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { JsonFileStore } from "../storage/jsonFile.js";
import type { SettingsStore } from "../settings/settingsStore.js";
import { HttpPreProxyToHttpAgent, HttpPreProxyToSocksAgent } from "./chainedAgent.js";
import {
  armProxyConnectTimeout,
  type ProxyConnectionControl,
} from "./connectTimeout.js";
import { ConnectTimeoutSocksProxyAgent } from "./socksConnectAgent.js";

export type ProxyType = "http" | "https" | "socks5";

export interface ProxyNode {
  id: string;
  name: string;
  type: ProxyType;
  url: string;
  source: string | null;
  enabled: boolean;
  weight: number;
  maxConcurrency: number;
  currentConcurrency: number;
  dailyRequestLimit: number;
  dailyRequestCount: number;
  dailyCountDate: string;
  autoDisableWhenDailyLimitReached: boolean;
  consecutiveRateLimitCount: number;
  cooldownUntil: string | null;
  successCount: number;
  failCount: number;
  recentResults: ProxyRequestResult[];
  lastError: string | null;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
}

export interface ProxyRequestResult {
  at: string;
  ok: boolean;
  statusCode: number;
}

interface ProxyFile {
  version: 1;
  proxies: ProxyNode[];
}

export interface ProxyInput {
  name?: string;
  type?: ProxyType;
  url?: string;
  enabled?: boolean;
  weight?: number;
  maxConcurrency?: number;
  dailyRequestLimit?: number;
  autoDisableWhenDailyLimitReached?: boolean;
}

export interface ProxyLease {
  node: ProxyNode | null;
  agent?: https.Agent;
  connection?: ProxyConnectionControl;
  requiredUnavailable?: boolean;
}

interface ProxyAgentHandle {
  agent: https.Agent;
  connection: ProxyConnectionControl;
}

export interface ProxyImportResult {
  created: ProxyNode[];
  skipped: string[];
}

export interface ProxySourceSyncResult {
  source: string;
  received: number;
  created: number;
  retained: number;
  removed: number;
  total: number;
}

export interface ProxyCleanupFailure {
  id: string;
  name: string;
  error: string;
}

export interface ProxyCleanupResult {
  tested: number;
  deleted: number;
  remaining: number;
  failures: ProxyCleanupFailure[];
}

export interface ProxyCleanupQueueStatus {
  running: boolean;
  total: number;
  queued: number;
  checking: number;
  completed: number;
  succeeded: number;
  failed: number;
  deleted: number;
  remaining: number;
  concurrency: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ProxyPoolOptions {
  probe?: (node: ProxyNode) => Promise<void>;
  testUrl?: string;
  testTimeoutMs?: number;
}

export const DEFAULT_PROXY_CONNECTIVITY_CHECK_URL = "https://cp.cloudflare.com/generate_204";
export const DEFAULT_PROXY_CHECK_CONCURRENCY = 10;

const today = () => new Date().toISOString().slice(0, 10);

export class ProxyPoolStore {
  private readonly store: JsonFileStore<ProxyFile>;
  private proxies: ProxyNode[] = [];
  private cleanupTail: Promise<void> = Promise.resolve();
  private cleanupQueueStatus: ProxyCleanupQueueStatus = {
    running: false,
    total: 0,
    queued: 0,
    checking: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    deleted: 0,
    remaining: 0,
    concurrency: DEFAULT_PROXY_CHECK_CONCURRENCY,
    startedAt: null,
    completedAt: null,
  };

  constructor(
    proxiesFile: string,
    private readonly settingsStore: SettingsStore,
    private readonly options: ProxyPoolOptions = {},
  ) {
    this.store = new JsonFileStore<ProxyFile>(proxiesFile);
  }

  load(): void {
    const data = this.store.read({ version: 1, proxies: [] });
    this.proxies = data.proxies.map((node) => this.normalizeDaily(node));
    this.persist();
  }

  list(): ProxyNode[] {
    this.resetDailyIfNeeded();
    return this.proxies.map((proxy) => ({ ...proxy }));
  }

  getCleanupQueueStatus(): ProxyCleanupQueueStatus {
    return { ...this.cleanupQueueStatus };
  }

  create(input: ProxyInput): ProxyNode {
    const node = this.buildNode(input);
    this.validateNode(node);
    this.proxies.push(node);
    this.persist();
    return { ...node };
  }

  import(addresses: string[]): ProxyImportResult {
    const existingUrls = new Set(this.proxies.map((proxy) => proxy.url));
    const pendingUrls = new Set<string>();
    const created: ProxyNode[] = [];
    const skipped: string[] = [];

    for (const [index, rawAddress] of addresses.entries()) {
      if (!rawAddress.trim()) continue;
      const parsedAddress = this.parseAddress(rawAddress, `Line ${index + 1}`);
      if (existingUrls.has(parsedAddress.url) || pendingUrls.has(parsedAddress.url)) {
        skipped.push(parsedAddress.url);
        continue;
      }

      const node = this.buildNode({
        name: parsedAddress.name,
        type: parsedAddress.type,
        url: parsedAddress.url,
      });
      try {
        this.validateNode(node);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid proxy URL";
        throw new Error(`Line ${index + 1}: ${message}`);
      }
      created.push(node);
      pendingUrls.add(parsedAddress.url);
    }

    if (created.length) {
      this.proxies.push(...created);
      this.persist();
    }
    return { created: created.map((node) => ({ ...node })), skipped };
  }

  syncSource(source: string, addresses: string[]): ProxySourceSyncResult {
    const normalizedSource = source.trim();
    if (!normalizedSource) throw new Error("Proxy source is required");

    const desired = new Map<string, { name: string; type: ProxyType; url: string }>();
    for (const [index, rawAddress] of addresses.entries()) {
      if (!rawAddress.trim()) continue;
      const parsedAddress = this.parseAddress(rawAddress, `Proxy ${index + 1}`);
      desired.set(parsedAddress.url, parsedAddress);
    }
    if (desired.size === 0) throw new Error("Proxy source returned no valid addresses");

    const desiredUrls = new Set(desired.keys());
    const retainedProxies = this.proxies.filter((node) => node.source !== normalizedSource || desiredUrls.has(node.url));
    const removed = this.proxies.length - retainedProxies.length;
    const existingUrls = new Set(retainedProxies.map((node) => node.url));
    let retained = 0;
    let created = 0;

    for (const address of desired.values()) {
      if (existingUrls.has(address.url)) {
        retained += 1;
        continue;
      }
      const node = this.buildNode({
        name: address.name,
        type: address.type,
        url: address.url,
      }, normalizedSource);
      this.validateNode(node);
      retainedProxies.push(node);
      existingUrls.add(address.url);
      created += 1;
    }

    this.proxies = retainedProxies;
    this.persist();
    return {
      source: normalizedSource,
      received: desired.size,
      created,
      retained,
      removed,
      total: this.proxies.length,
    };
  }

  update(id: string, input: ProxyInput): ProxyNode {
    const node = this.find(id);
    if (!node) throw new Error("Proxy not found");

    if (input.name !== undefined) node.name = input.name.trim();
    if (input.type !== undefined) node.type = input.type;
    if (input.url !== undefined) node.url = input.url.trim();
    if (input.enabled !== undefined) {
      node.enabled = input.enabled;
      if (input.enabled) {
        node.consecutiveRateLimitCount = 0;
        if (node.lastError === "Disabled after 5 consecutive 429 responses") node.lastError = null;
      }
    }
    if (input.weight !== undefined) node.weight = Math.max(1, Math.trunc(input.weight));
    if (input.maxConcurrency !== undefined) node.maxConcurrency = Math.max(1, Math.trunc(input.maxConcurrency));
    if (input.dailyRequestLimit !== undefined) node.dailyRequestLimit = Math.max(0, Math.trunc(input.dailyRequestLimit));
    if (input.autoDisableWhenDailyLimitReached !== undefined) node.autoDisableWhenDailyLimitReached = input.autoDisableWhenDailyLimitReached;

    this.validateNode(node);
    this.persist();
    return { ...node };
  }

  delete(id: string): boolean {
    const before = this.proxies.length;
    this.proxies = this.proxies.filter((node) => node.id !== id);
    if (this.proxies.length === before) return false;
    this.persist();
    return true;
  }

  clear(): number {
    const deleted = this.proxies.length;
    if (deleted === 0) return 0;
    this.proxies = [];
    this.persist();
    return deleted;
  }

  acquire(excludedIds: ReadonlySet<string> = new Set()): ProxyLease {
    this.resetDailyIfNeeded();
    const now = Date.now();
    const candidates = this.proxies
      .filter((node) => node.enabled)
      .filter((node) => !excludedIds.has(node.id))
      .filter((node) => !node.cooldownUntil || Date.parse(node.cooldownUntil) <= now)
      .filter((node) => node.dailyRequestLimit === 0 || node.dailyRequestCount < node.dailyRequestLimit)
      .filter((node) => node.currentConcurrency < node.maxConcurrency)
      .sort((a, b) => b.weight - a.weight);

    const node = candidates[0];
    if (!node) return { node: null, requiredUnavailable: this.settingsStore.get().proxyMode === "required" };

    node.currentConcurrency += 1;
    node.dailyRequestCount += 1;
    node.lastUsedAt = new Date().toISOString();
    this.disableIfDailyLimitReached(node);
    this.persist();

    const handle = this.createAgent(node);
    return {
      node: { ...node },
      agent: handle.agent,
      connection: handle.connection,
    };
  }

  release(id: string): void {
    const node = this.find(id);
    if (!node) return;
    node.currentConcurrency = Math.max(0, node.currentConcurrency - 1);
    this.persist();
  }

  markSuccess(id: string): void {
    const node = this.find(id);
    if (!node) return;
    node.successCount += 1;
    node.consecutiveRateLimitCount = 0;
    this.recordResult(node, true, 200);
    node.lastError = null;
    node.lastCheckedAt = new Date().toISOString();
    this.release(id);
  }

  markFailure(id: string, error: string, options: { statusCode?: number; cooldownMs?: number } = {}): void {
    const node = this.find(id);
    if (!node) return;
    node.failCount += 1;
    this.recordResult(node, false, options.statusCode || 502);
    node.lastError = error;
    node.lastCheckedAt = new Date().toISOString();
    if (options.statusCode === 429) {
      node.consecutiveRateLimitCount += 1;
      if (node.consecutiveRateLimitCount >= 5) {
        node.enabled = false;
        node.cooldownUntil = null;
        node.lastError = "Disabled after 5 consecutive 429 responses";
      }
    } else {
      node.cooldownUntil = new Date(Date.now() + (options.cooldownMs ?? 5 * 60 * 1000)).toISOString();
    }
    this.release(id);
  }

  async test(id: string): Promise<ProxyNode> {
    const node = this.find(id);
    if (!node) throw new Error("Proxy not found");
    this.validateNode(node);

    try {
      await this.probeNode({ ...node });
      node.lastCheckedAt = new Date().toISOString();
      node.lastError = null;
      this.persist();
      return { ...node };
    } catch (error) {
      node.lastCheckedAt = new Date().toISOString();
      node.lastError = error instanceof Error ? error.message : "Proxy test failed";
      this.persist();
      throw error;
    }
  }

  cleanupInvalid(concurrency = DEFAULT_PROXY_CHECK_CONCURRENCY): Promise<ProxyCleanupResult> {
    const run = this.cleanupTail.then(() => this.runCleanupInvalid(concurrency));
    this.cleanupTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async runCleanupInvalid(concurrency: number): Promise<ProxyCleanupResult> {
    const snapshot = this.proxies.map((node) => ({ ...node }));
    const concurrencyLimit = Number.isFinite(concurrency) ? Math.max(1, Math.trunc(concurrency)) : 1;
    const workerCount = Math.min(snapshot.length, concurrencyLimit);
    const startedAt = new Date().toISOString();
    this.cleanupQueueStatus = {
      running: snapshot.length > 0,
      total: snapshot.length,
      queued: snapshot.length,
      checking: 0,
      completed: 0,
      succeeded: 0,
      failed: 0,
      deleted: 0,
      remaining: this.proxies.length,
      concurrency: workerCount,
      startedAt,
      completedAt: snapshot.length === 0 ? startedAt : null,
    };
    if (snapshot.length === 0) return { tested: 0, deleted: 0, remaining: 0, failures: [] };

    try {
      const failed = new Map<string, { url: string; failure: ProxyCleanupFailure }>();
      const succeeded = new Map<string, string>();
      let cursor = 0;

      const worker = async () => {
        while (cursor < snapshot.length) {
          const index = cursor;
          cursor += 1;
          const node = snapshot[index];
          if (!node) continue;
          this.cleanupQueueStatus.queued -= 1;
          this.cleanupQueueStatus.checking += 1;
          try {
            this.validateNode(node);
            await this.probeNode(node);
            succeeded.set(node.id, node.url);
            this.cleanupQueueStatus.succeeded += 1;
          } catch (error) {
            failed.set(node.id, {
              url: node.url,
              failure: {
                id: node.id,
                name: node.name,
                error: error instanceof Error ? error.message : "Proxy test failed",
              },
            });
            this.cleanupQueueStatus.failed += 1;
          } finally {
            this.cleanupQueueStatus.checking -= 1;
            this.cleanupQueueStatus.completed += 1;
          }
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      const checkedAt = new Date().toISOString();
      for (const node of this.proxies) {
        if (succeeded.get(node.id) !== node.url) continue;
        node.lastCheckedAt = checkedAt;
        node.lastError = null;
      }

      const before = this.proxies.length;
      this.proxies = this.proxies.filter((node) => {
        const failedNode = failed.get(node.id);
        return !failedNode || failedNode.url !== node.url;
      });
      const deleted = before - this.proxies.length;
      this.persist();
      this.cleanupQueueStatus.deleted = deleted;
      this.cleanupQueueStatus.remaining = this.proxies.length;

      return {
        tested: snapshot.length,
        deleted,
        remaining: this.proxies.length,
        failures: [...failed.values()].map(({ failure }) => failure),
      };
    } finally {
      this.cleanupQueueStatus.running = false;
      this.cleanupQueueStatus.completedAt = new Date().toISOString();
    }
  }

  private buildNode(input: ProxyInput, source: string | null = null): ProxyNode {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      name: input.name?.trim() || "未命名代理",
      type: input.type || "http",
      url: input.url?.trim() || "",
      source,
      enabled: input.enabled ?? true,
      weight: Math.max(1, Math.trunc(input.weight || 1)),
      maxConcurrency: Math.max(1, Math.trunc(input.maxConcurrency || 10)),
      currentConcurrency: 0,
      dailyRequestLimit: Math.max(0, Math.trunc(input.dailyRequestLimit || 0)),
      dailyRequestCount: 0,
      dailyCountDate: today(),
      autoDisableWhenDailyLimitReached: input.autoDisableWhenDailyLimitReached ?? false,
      consecutiveRateLimitCount: 0,
      cooldownUntil: null,
      successCount: 0,
      failCount: 0,
      recentResults: [],
      lastError: null,
      lastUsedAt: null,
      lastCheckedAt: now,
    };
  }

  private createAgent(node: ProxyNode): ProxyAgentHandle {
    const settings = this.settingsStore.get();
    const preProxyUrl = settings.outboundPreProxyEnabled ? settings.outboundPreProxyUrl : "";
    const controller = new AbortController();
    const connection: ProxyConnectionControl = {
      timeoutMs: settings.proxyConnectTimeoutMs,
      abort: (reason) => {
        if (!controller.signal.aborted) controller.abort(reason);
      },
    };

    let agent: https.Agent;
    if (preProxyUrl && node.type === "socks5") {
      agent = new HttpPreProxyToSocksAgent(preProxyUrl, node.url, controller.signal);
    } else if (preProxyUrl && ["http", "https"].includes(node.type)) {
      agent = new HttpPreProxyToHttpAgent(preProxyUrl, node.url, controller.signal);
    } else if (node.type === "socks5") {
      agent = new ConnectTimeoutSocksProxyAgent(
        node.url,
        settings.proxyConnectTimeoutMs,
        controller.signal,
      ) as unknown as https.Agent;
    } else {
      agent = new HttpsProxyAgent(node.url, {
        signal: controller.signal,
      }) as unknown as https.Agent;
    }
    return { agent, connection };
  }

  private async probeNode(node: ProxyNode): Promise<void> {
    if (this.options.probe) {
      await this.options.probe({ ...node });
      return;
    }

    const testUrl = this.options.testUrl || DEFAULT_PROXY_CONNECTIVITY_CHECK_URL;
    const timeoutMs = this.options.testTimeoutMs ?? 10000;
    await new Promise<void>((resolve, reject) => {
      const handle = this.createAgent(node);
      const req = https.get(testUrl, { agent: handle.agent, timeout: timeoutMs }, (res) => {
        const statusCode = res.statusCode || 0;
        res.resume();
        res.on("error", reject);
        res.on("end", () => {
          if (statusCode >= 200 && statusCode < 400) {
            resolve();
            return;
          }
          reject(new Error(`Proxy test returned HTTP ${statusCode || "unknown"}`));
        });
      });
      const connectTimeout = armProxyConnectTimeout(req, handle.connection);
      req.on("error", (error) => reject(connectTimeout.getError() || error));
      req.on("timeout", () => {
        req.destroy(new Error(`Proxy test timeout after ${timeoutMs}ms`));
      });
    });
  }

  private parseAddress(rawAddress: string, label: string): { name: string; type: ProxyType; url: string } {
    const address = rawAddress.trim();
    const normalizedAddress = /^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `http://${address}`;
    let parsed: URL;
    try {
      parsed = new URL(normalizedAddress);
    } catch {
      throw new Error(`${label}: invalid proxy URL`);
    }

    let type: ProxyType;
    if (parsed.protocol === "socks:" || parsed.protocol === "socks5:") {
      type = "socks5";
    } else if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      type = parsed.protocol === "https:" ? "https" : "http";
    } else {
      throw new Error(`${label}: unsupported proxy protocol`);
    }
    return {
      name: `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`,
      type,
      url: normalizedAddress,
    };
  }

  private validateNode(node: ProxyNode): void {
    if (!node.name.trim()) throw new Error("Proxy name is required");
    if (!node.url.trim()) throw new Error("Proxy url is required");
    if (!['http', 'https', 'socks5'].includes(node.type)) throw new Error("Unsupported proxy type");
    const parsed = new URL(node.url);
    if (node.type === "socks5" && !parsed.protocol.startsWith("socks")) throw new Error("SOCKS5 proxy url must use socks:// or socks5://");
    if (node.type !== "socks5" && !["http:", "https:"].includes(parsed.protocol)) throw new Error("HTTP proxy url must use http:// or https://");
  }

  private resetDailyIfNeeded(): void {
    const current = today();
    let changed = false;
    for (const node of this.proxies) {
      if (node.dailyCountDate === current) continue;
      node.dailyCountDate = current;
      node.dailyRequestCount = 0;
      if (node.autoDisableWhenDailyLimitReached && node.lastError === "Daily request limit reached") {
        node.enabled = true;
        node.lastError = null;
      }
      changed = true;
    }
    if (changed) this.persist();
  }

  private normalizeDaily(node: ProxyNode): ProxyNode {
    return {
      ...node,
      source: node.source || null,
      currentConcurrency: 0,
      dailyCountDate: node.dailyCountDate || today(),
      dailyRequestLimit: node.dailyRequestLimit || 0,
      dailyRequestCount: node.dailyRequestCount || 0,
      autoDisableWhenDailyLimitReached: Boolean(node.autoDisableWhenDailyLimitReached),
      consecutiveRateLimitCount: node.consecutiveRateLimitCount || 0,
      recentResults: node.recentResults || [],
    };
  }

  private recordResult(node: ProxyNode, ok: boolean, statusCode: number): void {
    node.recentResults = [...(node.recentResults || []), { at: new Date().toISOString(), ok, statusCode }].slice(-20);
  }

  private disableIfDailyLimitReached(node: ProxyNode): void {
    if (node.dailyRequestLimit === 0 || node.dailyRequestCount < node.dailyRequestLimit) return;
    if (!node.autoDisableWhenDailyLimitReached) return;
    node.enabled = false;
    node.lastError = "Daily request limit reached";
  }

  private find(id: string): ProxyNode | undefined {
    return this.proxies.find((node) => node.id === id);
  }

  private persist(): void {
    this.store.write({ version: 1, proxies: this.proxies });
  }
}
