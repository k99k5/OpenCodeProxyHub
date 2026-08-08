import {
  DEFAULT_PROXY_CHECK_CONCURRENCY,
  type ProxyCleanupResult,
  type ProxyCleanupQueueStatus,
  type ProxySourceSyncResult,
  type ProxyPoolStore,
} from "./proxyPool.js";
import type { SettingsStore } from "../settings/settingsStore.js";

export const SCDN_PROXY_SOURCE = "scdn-http";
export const SCDN_PROXY_API_URL = "https://proxy.scdn.io/api/get_proxy.php?protocol=http&count=20";
export const PROXY_SYNC_TARGET_COUNT = 1000;

const DEFAULT_BATCH_SIZE = 20;
// SCDN returns at most 20 proxies per request. Allow twice the minimum number
// of batches so a sync can still reach the target when batches overlap.
const DEFAULT_MAX_BATCHES = 100;
// Leave enough time for 100 sequential batches and transient-provider retries.
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
// The provider rejects bursts from the same client with its non-standard 456
// status, so batches must be issued sequentially.
const MAX_BATCH_ATTEMPTS = 4;
const RETRYABLE_HTTP_STATUSES = new Set([429, 456]);
const DEFAULT_RETRY_DELAY_MS = 1000;

export interface ProxySyncRunResult extends ProxySourceSyncResult {
  batches: number;
  cleanup: ProxyCleanupResult;
}

export interface ProxySyncStatus {
  enabled: boolean;
  intervalMinutes: number;
  running: boolean;
  targetCount: number;
  requestTimeoutMs: number;
  sourceUrl: string;
  nextRunAt: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastResult: ProxySyncRunResult | null;
  cleanupQueue: ProxyCleanupQueueStatus;
}

interface ProxySyncLogger {
  info: (details: Record<string, unknown>, message: string) => void;
  error: (details: Record<string, unknown>, message: string) => void;
}

export interface ProxySyncOptions {
  fetchImpl?: typeof fetch;
  logger?: ProxySyncLogger;
  sourceUrl?: string;
  targetCount?: number;
  batchSize?: number;
  maxBatches?: number;
  requestTimeoutMs?: number;
  cleanupConcurrency?: number;
}

export class ProxySyncService {
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: ProxySyncLogger;
  private readonly sourceUrl: string;
  private readonly targetCount: number;
  private readonly batchSize: number;
  private readonly maxBatches: number;
  private readonly requestTimeoutMs: number;
  private readonly cleanupConcurrency: number;
  private started = false;
  private enabled = false;
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<ProxySyncRunResult> | null = null;
  private activeController: AbortController | null = null;
  private nextRunAt: string | null = null;
  private lastStartedAt: string | null = null;
  private lastCompletedAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private lastResult: ProxySyncRunResult | null = null;

  constructor(
    private readonly proxyPool: ProxyPoolStore,
    private readonly settingsStore: SettingsStore,
    options: ProxySyncOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.logger = options.logger;
    this.sourceUrl = options.sourceUrl || SCDN_PROXY_API_URL;
    this.targetCount = options.targetCount ?? PROXY_SYNC_TARGET_COUNT;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.cleanupConcurrency = options.cleanupConcurrency ?? DEFAULT_PROXY_CHECK_CONCURRENCY;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.enabled = this.settingsStore.get().proxyAutoSyncEnabled;
    if (this.enabled) this.schedule(0);
  }

  stop(): void {
    this.started = false;
    this.enabled = false;
    this.clearTimer();
    this.activeController?.abort();
    this.nextRunAt = null;
  }

  reconfigure(): void {
    const wasEnabled = this.enabled;
    this.enabled = this.settingsStore.get().proxyAutoSyncEnabled;
    this.clearTimer();
    this.nextRunAt = null;
    if (!this.started || !this.enabled || this.activeRun) return;
    this.schedule(wasEnabled ? this.intervalMs() : 0);
  }

  getStatus(): ProxySyncStatus {
    const settings = this.settingsStore.get();
    return {
      enabled: settings.proxyAutoSyncEnabled,
      intervalMinutes: settings.proxyAutoSyncIntervalMinutes,
      running: Boolean(this.activeRun),
      targetCount: this.targetCount,
      requestTimeoutMs: this.requestTimeoutMs,
      sourceUrl: this.sourceUrl,
      nextRunAt: this.nextRunAt,
      lastStartedAt: this.lastStartedAt,
      lastCompletedAt: this.lastCompletedAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      lastResult: this.lastResult ? {
        ...this.lastResult,
        cleanup: {
          ...this.lastResult.cleanup,
          failures: this.lastResult.cleanup.failures.map((failure) => ({ ...failure })),
        },
      } : null,
      cleanupQueue: this.proxyPool.getCleanupQueueStatus(),
    };
  }

  async syncNow(): Promise<ProxySyncRunResult> {
    if (this.activeRun) return this.activeRun;
    this.clearTimer();
    this.nextRunAt = null;
    this.lastStartedAt = new Date().toISOString();
    this.lastError = null;

    const run = this.performSync();
    this.activeRun = run;
    try {
      const result = await run;
      this.lastCompletedAt = new Date().toISOString();
      this.lastSuccessAt = this.lastCompletedAt;
      this.lastResult = result;
      this.logger?.info({
        batches: result.batches,
        received: result.received,
        created: result.created,
        retained: result.retained,
        removed: result.removed,
        cleanupTested: result.cleanup.tested,
        cleanupDeleted: result.cleanup.deleted,
        remaining: result.cleanup.remaining,
      }, "proxy_sync_completed");
      return result;
    } catch (error) {
      this.lastCompletedAt = new Date().toISOString();
      this.lastError = error instanceof Error ? error.message : "Proxy sync failed";
      this.logger?.error({ error: this.lastError }, "proxy_sync_failed");
      throw error;
    } finally {
      this.activeRun = null;
      this.activeController = null;
      this.enabled = this.settingsStore.get().proxyAutoSyncEnabled;
      if (this.started && this.enabled) this.schedule(this.intervalMs());
    }
  }

  private async performSync(): Promise<ProxySyncRunResult> {
    const { addresses, batches } = await this.fetchAddressesWithTimeout();
    const result = this.proxyPool.syncSource(SCDN_PROXY_SOURCE, addresses);
    const cleanup = await this.proxyPool.cleanupInvalid(this.cleanupConcurrency);
    return { ...result, total: cleanup.remaining, batches, cleanup };
  }

  private async fetchAddressesWithTimeout(): Promise<{ addresses: string[]; batches: number }> {
    const controller = new AbortController();
    this.activeController = controller;
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchAddresses(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Proxy sync timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.activeController = null;
    }
  }

  private async fetchAddresses(signal: AbortSignal): Promise<{ addresses: string[]; batches: number }> {
    const addresses = new Set<string>();
    let batches = 0;

    while (addresses.size < this.targetCount && batches < this.maxBatches) {
      const remaining = this.targetCount - addresses.size;
      const response = await this.fetchBatch(signal, Math.min(remaining, this.batchSize));
      batches += 1;
      for (const address of response) {
        const normalized = address.trim();
        if (normalized) addresses.add(normalized);
        if (addresses.size >= this.targetCount) break;
      }
    }

    if (addresses.size < this.targetCount) {
      throw new Error(
        `Proxy provider returned only ${addresses.size} unique addresses after ${batches} batches; ${this.targetCount} required`,
      );
    }
    return { addresses: [...addresses].slice(0, this.targetCount), batches };
  }

  private async fetchBatch(signal: AbortSignal, requestedCount: number): Promise<string[]> {
    let response: Response | undefined;
    const url = new URL(this.sourceUrl);
    url.searchParams.set("count", String(requestedCount));
    for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt += 1) {
      response = await this.fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal,
      });
      if (response.ok) break;

      const retryable = RETRYABLE_HTTP_STATUSES.has(response.status) || response.status >= 500;
      if (!retryable || attempt === MAX_BATCH_ATTEMPTS) {
        throw new Error(`Proxy provider returned HTTP ${response.status}`);
      }
      await this.waitForRetry(response, attempt, signal);
    }

    if (!response?.ok) throw new Error("Proxy provider request failed");

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") throw new Error("Proxy provider returned an invalid response");
    const record = payload as Record<string, unknown>;
    if (Number(record.code) !== 200) {
      const message = typeof record.message === "string" ? record.message : "unknown provider error";
      throw new Error(`Proxy provider error: ${message}`);
    }
    if (!record.data || typeof record.data !== "object") throw new Error("Proxy provider response is missing data");
    const proxies = (record.data as Record<string, unknown>).proxies;
    if (!Array.isArray(proxies)) throw new Error("Proxy provider response is missing proxies");
    return proxies.filter((item): item is string => typeof item === "string");
  }

  private async waitForRetry(response: Response, attempt: number, signal: AbortSignal): Promise<void> {
    const retryAfter = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    const delayMs = Number.isFinite(retryAfterSeconds)
      ? Math.max(0, retryAfterSeconds * 1000)
      : DEFAULT_RETRY_DELAY_MS * (2 ** (attempt - 1));

    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, delayMs);
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private intervalMs(): number {
    return this.settingsStore.get().proxyAutoSyncIntervalMinutes * 60 * 1000;
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (!this.started || !this.enabled) return;
    const normalizedDelay = Math.max(0, delayMs);
    this.nextRunAt = new Date(Date.now() + normalizedDelay).toISOString();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextRunAt = null;
      void this.syncNow().catch(() => undefined);
    }, normalizedDelay);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
