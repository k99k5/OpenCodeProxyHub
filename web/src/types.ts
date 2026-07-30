export type View = "dashboard" | "keys" | "models" | "settings" | "proxy" | "monitor";
export type AuthMode = "password";

export interface ApiKeyItem {
  id: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  description?: string;
  labels: string[];
  policy: {
    requestsPerMinute?: number;
    maxConcurrentRequests?: number;
    maxConcurrentStreams?: number;
    allowedModels?: string[];
    allowProxy?: boolean;
  };
  requestCount: number;
  recentClients: Array<{ id: string; userAgent: string; firstSeenAt: string; lastSeenAt: string; requestCount: number }>;
  hasRecoverableKey: boolean;
}

export type ApiKeyPolicy = ApiKeyItem["policy"];

export interface ModelItem {
  id: string;
  enabled: boolean;
  ownedBy: string;
  created: number;
  displayName?: string;
}

export interface SystemSettings {
  requestBodyLimitBytes: number;
  upstreamTimeoutMs: number;
  defaultStream: boolean;
  logPrompts: boolean;
  openAiStreamTransformModels: string[];
  reasoningTagModels: string[];
  proxyMode: "direct" | "optional" | "required";
  outboundPreProxyEnabled: boolean;
  outboundPreProxyUrl: string;
  proxyAutoSyncEnabled: boolean;
  proxyAutoSyncIntervalMinutes: number;
  logEnabled: boolean;
  logAudit: boolean;
  logApiRequests: boolean;
  logMaxBodyChars: number;
  logRetentionDays: number;
}

export interface ProxyNode {
  id: string;
  name: string;
  type: "http" | "https" | "socks5";
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
  recentResults: Array<{ at: string; ok: boolean; statusCode: number }>;
  lastError: string | null;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
}

export interface ProxySyncRunResult {
  source: string;
  received: number;
  created: number;
  retained: number;
  removed: number;
  total: number;
  batches: number;
}

export interface ProxySyncStatus {
  enabled: boolean;
  intervalMinutes: number;
  running: boolean;
  targetCount: number;
  sourceUrl: string;
  nextRunAt: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastResult: ProxySyncRunResult | null;
}

export interface HealthPayload {
  status: string;
  version: string;
  models: number;
}

export interface RuntimePayload {
  runtime: { draining: boolean; inFlightRequests: number };
  limiter: { backend: string; globalRequestsPerMinute: number; apiKeyRequestsPerMinute: number; apiKeyMaxConcurrentRequests: number; apiKeyMaxConcurrentStreams: number };
}

export interface MetricsPayload {
  startedAt: string;
  uptimeSeconds: number;
  http: {
    totalRequests: number;
    errorRequests: number;
    errorRate: number;
    byStatus: Record<string, number>;
    byRoute: Record<string, number>;
    latencyMs: { p50: number; p95: number; p99: number };
  };
  upstream: {
    totalRequests: number;
    errorRequests: number;
    errorRate: number;
    byStatus: Record<string, number>;
    byProxy: Record<string, number>;
    latencyMs: { p50: number; p95: number; p99: number };
  };
  recentErrors: Array<{ at: string; scope: string; message: string; statusCode?: number }>;
}

export interface ProxyDraft {
  name: string;
  type: string;
  url: string;
  dailyRequestLimit: number;
  maxConcurrency: number;
}
