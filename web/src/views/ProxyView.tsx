import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, Check, CheckCircle2, Download, FileUp, Network, Plus, RefreshCw, Route, ShieldCheck, Trash2, Waypoints } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { fadeUp, staggerContainer } from "@/lib/motion";
import type { ConsoleData } from "../hooks/useConsoleData";
import type { ProxyDraft, ProxyNode } from "../types";
import { MeterBar } from "../components/MeterBar";
import { ResultStrip } from "../components/ResultStrip";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";

const proxyModes = [
  { value: "direct", label: "直连", description: "所有请求不使用代理池" },
  { value: "optional", label: "优先代理", description: "有可用节点则使用，否则直连" },
  { value: "required", label: "强制代理", description: "无可用节点时请求失败" },
] as const;

const isDailyLimitPaused = (proxy: ProxyNode) =>
  !proxy.enabled && proxy.disabledReason === "daily_limit";

const stateBadge = (proxy: ProxyNode): { label: string; variant: "muted" | "warning" | "info" | "destructive" | "success" } => {
  if (isDailyLimitPaused(proxy)) return { label: "额度暂停", variant: "warning" };
  if (!proxy.enabled) return { label: "已禁用", variant: "muted" };
  if (proxy.consecutiveRateLimitCount >= 1) return { label: "429 风险", variant: "warning" };
  if (proxy.cooldownUntil && Date.parse(proxy.cooldownUntil) > Date.now()) return { label: "冷却中", variant: "info" };
  if (proxy.lastError) return { label: "异常", variant: "destructive" };
  return { label: "健康", variant: "success" };
};

const VIRTUAL_ROW_HEIGHT = 390;
const VIRTUAL_OVERSCAN = 3;

export function ProxyView({ data }: { data: ConsoleData }) {
  const {
    proxies,
    settings,
    proxySyncStatus,
    busy,
    createProxy,
    importProxies,
    toggleProxy,
    testProxy,
    deleteProxy,
    clearProxies,
    syncProxies,
    cleanupInvalidProxies,
    updateSettings,
  } = data;
  const [draft, setDraft] = useState<ProxyDraft>({ name: "香港节点 1", type: "http", url: "", dailyRequestLimit: 1000, maxConcurrency: 10 });
  const [deleteTarget, setDeleteTarget] = useState<ProxyNode | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [cleanupConfirmOpen, setCleanupConfirmOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importFileName, setImportFileName] = useState("");
  const [importFileError, setImportFileError] = useState("");
  const importFileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(720);
  const [listWidth, setListWidth] = useState(0);
  const hasProxies = proxies.length > 0;
  const enabledProxyCount = proxies.filter((proxy) => proxy.enabled).length;
  const dailyLimitPausedCount = proxies.filter(isDailyLimitPaused).length;
  const disabledProxyCount = proxies.length - enabledProxyCount - dailyLimitPausedCount;

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const updateListSize = () => {
      setListHeight(element.clientHeight);
      setListWidth(element.clientWidth);
    };
    updateListSize();
    const observer = new ResizeObserver(updateListSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasProxies]);

  const proxyMode = settings?.proxyMode ?? "optional";
  const preProxyEnabled = Boolean(settings?.outboundPreProxyEnabled);
  const [preProxyDraft, setPreProxyDraft] = useState("");
  useEffect(() => {
    setPreProxyDraft(settings?.outboundPreProxyUrl ?? "");
  }, [settings?.outboundPreProxyUrl]);
  const preProxyDirty = preProxyDraft.trim() !== (settings?.outboundPreProxyUrl ?? "");
  const [syncIntervalDraft, setSyncIntervalDraft] = useState(60);
  useEffect(() => {
    setSyncIntervalDraft(settings?.proxyAutoSyncIntervalMinutes ?? 60);
  }, [settings?.proxyAutoSyncIntervalMinutes]);
  const syncIntervalDirty = syncIntervalDraft !== (settings?.proxyAutoSyncIntervalMinutes ?? 60);
  const cleanupQueue = proxySyncStatus?.cleanupQueue;

  const prioritized = useMemo(() => {
    const now = Date.now();
    return (
      [...proxies]
        .filter((p) => p.enabled)
        .filter((p) => !p.cooldownUntil || Date.parse(p.cooldownUntil) <= now)
        .filter((p) => p.dailyRequestLimit === 0 || p.dailyRequestCount < p.dailyRequestLimit)
        .filter((p) => p.currentConcurrency < p.maxConcurrency)
        .sort((a, b) => b.weight - a.weight)[0] || null
    );
  }, [proxies]);

  const columnCount = listWidth >= 1024 ? 2 : 1;
  const totalRows = Math.ceil(proxies.length / columnCount);
  const firstRow = Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN);
  const visibleRows = Math.ceil(listHeight / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN * 2;
  const lastRow = Math.min(totalRows, firstRow + visibleRows);
  const visibleProxies = proxies.slice(firstRow * columnCount, lastRow * columnCount);

  return (
    <div className="space-y-4">
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="grid grid-cols-1 gap-3 md:grid-cols-3"
      >
        <motion.div variants={fadeUp}>
          <InfoCard icon={<Route size={16} className="text-primary" />} title="当前策略" value="优先填充" sub="高权重节点优先，同权重按顺序" />
        </motion.div>
        <motion.div variants={fadeUp}>
          <InfoCard icon={<AlertTriangle size={16} className="text-warning" />} title="429 熔断" value="1 次" sub="触发后自动禁用，需手动开启" />
        </motion.div>
        <motion.div variants={fadeUp}>
          <InfoCard icon={<CheckCircle2 size={16} className="text-success" />} title="优先节点" value={prioritized?.name || "无可用"} sub="按权重与可用性选出" />
        </motion.div>
      </motion.div>

      <Card className="p-5">
        <div className="flex items-center gap-2">
          <Route size={16} className="text-primary" />
          <h2 className="text-sm font-semibold">代理使用模式</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">控制请求是否使用出口代理池。该设置对下一个请求即时生效，无需重启。</p>
        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-3">
          {proxyModes.map((mode) => {
            const active = proxyMode === mode.value;
            return (
              <button
                key={mode.value}
                className={cn(
                  "group relative rounded-lg border p-4 text-left transition-colors",
                  active
                    ? "border-primary bg-primary/10 ring-1 ring-inset ring-primary/30"
                    : "border-border bg-muted/30 hover:bg-muted/50"
                )}
                disabled={busy || !settings}
                onClick={() => updateSettings({ proxyMode: mode.value })}
              >
                {active && (
                  <span className="absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-content">
                    <Check size={12} strokeWidth={3} />
                  </span>
                )}
                <span
                  className={cn(
                    "block text-sm font-medium",
                    active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
                  )}
                >
                  {mode.label}
                </span>
                <span className="text-xs text-muted-foreground">{mode.description}</span>
              </button>
            );
          })}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <RefreshCw size={16} className="text-primary" />
              <h2 className="text-sm font-semibold">代理自动维护</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              从 SCDN 分批获取并去重至 100 个 HTTP 代理；同步后保留每日额度暂停节点，直接清理其他禁用节点，其余节点加入公网检测队列。
            </p>
          </div>
          <Switch
            disabled={busy || !settings}
            checked={Boolean(settings?.proxyAutoSyncEnabled)}
            onCheckedChange={(enabled) => updateSettings({ proxyAutoSyncEnabled: enabled })}
          />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[minmax(180px,260px)_1fr]">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">同步间隔（分钟）</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                max={10080}
                value={syncIntervalDraft}
                disabled={busy || !settings}
                onChange={(event) => setSyncIntervalDraft(Number(event.target.value))}
              />
              <Button
                size="sm"
                disabled={busy || !settings || !syncIntervalDirty || syncIntervalDraft < 1 || syncIntervalDraft > 10080}
                onClick={() => updateSettings({ proxyAutoSyncIntervalMinutes: syncIntervalDraft })}
              >
                保存
              </Button>
            </div>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            <div>
              上次成功：
              <span className="ml-1 text-foreground">
                {proxySyncStatus?.lastSuccessAt ? new Date(proxySyncStatus.lastSuccessAt).toLocaleString() : "尚未同步"}
              </span>
            </div>
            {proxySyncStatus?.lastResult && (
              <div className="mt-1">
                获取 {proxySyncStatus.lastResult.received} · 新增 {proxySyncStatus.lastResult.created} ·
                保留 {proxySyncStatus.lastResult.retained} · 同步移除 {proxySyncStatus.lastResult.removed}
                <br />
                队列检测 {proxySyncStatus.lastResult.cleanup.tested} · 自动清理 {proxySyncStatus.lastResult.cleanup.deleted} ·
                剩余 {proxySyncStatus.lastResult.cleanup.remaining}
              </div>
            )}
            {proxySyncStatus?.lastError && <div className="mt-1 text-destructive">上次错误：{proxySyncStatus.lastError}</div>}
            <div className="mt-3 border-t border-border pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">检测队列</span>
                <Badge variant={cleanupQueue?.running || proxySyncStatus?.running ? "info" : cleanupQueue?.completedAt ? "success" : "muted"}>
                  {cleanupQueue?.running
                    ? "运行中"
                    : proxySyncStatus?.running
                      ? "等待同步完成"
                      : cleanupQueue?.completedAt
                        ? "已完成"
                        : "尚未运行"}
                </Badge>
                <span>Worker {cleanupQueue?.checking ?? 0}/{cleanupQueue?.concurrency ?? 10}</span>
              </div>
              {proxySyncStatus?.running && !cleanupQueue?.running ? (
                <div className="mt-2">正在获取代理，完成后会保留每日额度暂停节点，直接清理其他禁用节点，并将其余节点加入检测队列。</div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                  <span>总数 {cleanupQueue?.total ?? 0}</span>
                  <span>等待 {cleanupQueue?.queued ?? 0}</span>
                  <span>检测中 {cleanupQueue?.checking ?? 0}</span>
                  <span>已完成 {cleanupQueue?.completed ?? 0}</span>
                  <span>成功 {cleanupQueue?.succeeded ?? 0}</span>
                  <span>失败 {cleanupQueue?.failed ?? 0}</span>
                  <span>已删除 {cleanupQueue?.deleted ?? 0}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => syncProxies()}>
            <RefreshCw size={16} /> 立即同步 100 个
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={busy || proxies.length === 0}
            onClick={() => setCleanupConfirmOpen(true)}
          >
            <ShieldCheck size={16} /> 清理失效代理
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2">
          <Waypoints size={16} className="text-primary" />
          <h2 className="text-sm font-semibold">出站前置代理（链式代理）</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          开启后，所有代理节点的出站连接会先经此本机地址再连上游。仅当代理使用模式不是“直连”且请求实际选中代理节点时生效，修改后无需重启。
        </p>

        <div className="mt-4 flex items-start justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">前置代理</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {preProxyEnabled ? "已开启，节点经前置代理出网" : "已关闭，节点直连上游"}
            </div>
          </div>
          <Switch
            disabled={busy || !settings}
            checked={preProxyEnabled}
            onCheckedChange={() => updateSettings({ outboundPreProxyEnabled: !preProxyEnabled })}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label className="text-xs text-muted-foreground">前置代理地址（http/https）</Label>
            <Input
              value={preProxyDraft}
              disabled={busy || !settings}
              onChange={(e) => setPreProxyDraft(e.target.value)}
              placeholder="http://127.0.0.1:7897"
            />
          </div>
          <Button
            size="sm"
            disabled={busy || !settings || !preProxyDirty}
            onClick={() => updateSettings({ outboundPreProxyUrl: preProxyDraft.trim() })}
          >
            保存
          </Button>
        </div>
        {!(settings?.outboundPreProxyUrl || "").trim() && (
          <p className="mt-2 text-xs text-warning/90">请先填写并保存地址，再开启前置代理（直接开启会因地址为空而报错）。</p>
        )}
      </Card>

      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">新增代理节点</h2>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={busy || proxies.length === 0}
              onClick={() => setClearConfirmOpen(true)}
            >
              <Trash2 size={16} /> 一键清空
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setImportOpen(true)}>
              <Download size={16} /> 批量导入
            </Button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="w-36 space-y-1.5">
            <Label className="text-xs text-muted-foreground">名称</Label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="代理名称" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">类型</Label>
            <Select value={draft.type} onValueChange={(v) => setDraft({ ...draft, type: v })}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">HTTP</SelectItem>
                <SelectItem value="https">HTTPS</SelectItem>
                <SelectItem value="socks5">SOCKS5</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label className="text-xs text-muted-foreground">代理 URL</Label>
            <Input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="http://user:pass@1.2.3.4:8080" />
          </div>
          <div className="w-32 space-y-1.5">
            <Label className="text-xs text-muted-foreground">每日上限（0=不限）</Label>
            <Input
              type="number"
              min={0}
              value={draft.dailyRequestLimit}
              onChange={(e) => setDraft({ ...draft, dailyRequestLimit: Number(e.target.value) })}
            />
          </div>
          <div className="w-24 space-y-1.5">
            <Label className="text-xs text-muted-foreground">最大并发</Label>
            <Input
              type="number"
              min={1}
              value={draft.maxConcurrency}
              onChange={(e) => setDraft({ ...draft, maxConcurrency: Number(e.target.value) })}
            />
          </div>
          <Button size="sm" disabled={busy} onClick={() => createProxy(draft)}>
            <Plus size={16} /> 新增
          </Button>
        </div>
      </Card>

      {proxies.length === 0 && (
        <Card className="p-8">
          <div className="flex flex-col items-center text-center">
            <span className="grid h-12 w-12 place-items-center rounded-lg bg-muted/40 text-muted-foreground">
              <Network size={26} />
            </span>
            <h3 className="mt-3 text-sm font-semibold">尚未配置出口节点</h3>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              添加 HTTP、HTTPS 或 SOCKS5 代理后，网关会优先填充第一个可用节点，触发 1 次 429 即会自动禁用该节点。
            </p>
          </div>
        </Card>
      )}

      {hasProxies && (
        <div
          ref={listRef}
          className="oph-scroll h-[75vh] min-h-[480px] overflow-auto rounded-lg"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div className="relative" style={{ height: totalRows * VIRTUAL_ROW_HEIGHT }}>
            <motion.div
              variants={staggerContainer}
              initial="hidden"
              animate="show"
              className={cn("absolute left-0 right-0 grid gap-4", columnCount === 2 ? "grid-cols-2" : "grid-cols-1")}
              style={{ transform: `translateY(${firstRow * VIRTUAL_ROW_HEIGHT}px)` }}
            >
        {visibleProxies.map((proxy) => {
          const badge = stateBadge(proxy);
          const isPrimary = prioritized?.id === proxy.id;
          return (
            <motion.div key={proxy.id} variants={fadeUp} className="h-[374px]">
              <Card className={cn("h-full overflow-hidden p-4", isPrimary && "ring-2 ring-primary/40")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <strong className="truncate">{proxy.name}</strong>
                      <Badge variant="outline" className="uppercase">{proxy.type}</Badge>
                      {proxy.source && <Badge variant="muted">自动同步</Badge>}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{proxy.url}</p>
                  </div>
                  <Badge variant={isPrimary ? "default" : badge.variant} className="shrink-0">
                    {isPrimary ? "当前优先" : badge.label}
                  </Badge>
                </div>

                <div className="mt-4 space-y-3">
                  <MeterBar label="今日用量" current={proxy.dailyRequestCount} max={proxy.dailyRequestLimit} />
                  <MeterBar label="并发" current={proxy.currentConcurrency} max={proxy.maxConcurrency} />
                  <MeterBar label="连续 429" current={proxy.consecutiveRateLimitCount || 0} max={1} unlimitedText="1" />
                </div>

                {(() => {
                  const total = proxy.successCount + proxy.failCount;
                  const rate = total === 0 ? "—" : `${Math.round((proxy.successCount / total) * 100)}%`;
                  return (
                    <div className="mt-3 space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          成功率 <span className="font-medium tabular-nums text-foreground/80">{rate}</span>
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          总 {total} · 成 {proxy.successCount} · 败 {proxy.failCount}
                        </span>
                      </div>
                      <ResultStrip results={proxy.recentResults || []} />
                    </div>
                  );
                })()}

                <div className="mt-4 grid grid-cols-3 gap-2 rounded-md border border-border bg-muted/30 p-2 text-center text-xs">
                  <div>
                    <div className="text-muted-foreground">成功</div>
                    <div className="font-semibold tabular-nums text-success">{proxy.successCount}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">失败</div>
                    <div className="font-semibold tabular-nums text-destructive">{proxy.failCount}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">权重</div>
                    <div className="font-semibold tabular-nums">{proxy.weight}</div>
                  </div>
                </div>

                {proxy.lastError && <p className="mt-2 truncate text-xs text-destructive">最后错误：{proxy.lastError}</p>}

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggleProxy(proxy)}>
                    {proxy.enabled ? "禁用" : "启用"}
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => testProxy(proxy)}>
                    测试
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => setDeleteTarget(proxy)}
                  >
                    <Trash2 size={14} /> 删除
                  </Button>
                </div>
              </Card>
            </motion.div>
          );
        })}
            </motion.div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除代理节点"
        message={`确定删除代理「${deleteTarget?.name}」吗？`}
        confirmText="删除"
        busy={busy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteProxy(deleteTarget);
          setDeleteTarget(null);
        }}
      />

      <ConfirmDialog
        open={cleanupConfirmOpen}
        title="清理失效代理"
        message={`将保留 ${dailyLimitPausedCount} 个每日额度暂停代理，直接删除 ${disabledProxyCount} 个其他已禁用代理，并按队列检测 ${enabledProxyCount} 个已启用代理（最多 10 个同时检测）；无法访问公共互联网的节点也会永久删除。是否继续？`}
        confirmText="检测并清理"
        busy={busy}
        onCancel={() => setCleanupConfirmOpen(false)}
        onConfirm={async () => {
          const cleaned = await cleanupInvalidProxies();
          if (cleaned) setCleanupConfirmOpen(false);
        }}
      />

      <ConfirmDialog
        open={clearConfirmOpen}
        title="清空代理池"
        message={`确定删除全部 ${proxies.length} 个代理节点吗？此操作无法撤销。`}
        confirmText="全部删除"
        busy={busy}
        onCancel={() => setClearConfirmOpen(false)}
        onConfirm={async () => {
          const cleared = await clearProxies();
          if (cleared) setClearConfirmOpen(false);
        }}
      />

      <Modal
        open={importOpen}
        title="批量导入代理"
        icon={<Download size={18} className="text-primary" />}
        onClose={() => setImportOpen(false)}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setImportOpen(false)}>取消</Button>
            <Button
              disabled={busy || !importText.trim()}
              onClick={async () => {
                const imported = await importProxies(importText);
                if (!imported) return;
                setImportText("");
                setImportFileName("");
                setImportFileError("");
                setImportOpen(false);
              }}
            >
              {busy ? "导入中…" : "确认导入"}
            </Button>
          </>
        }
      >
        <p className="text-xs text-muted-foreground">
          每行填写一个代理地址，支持 http://、https://、socks:// 和 socks5://；省略协议时按 HTTP 导入。重复地址会自动跳过。
        </p>
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border bg-muted/20 p-3">
          <input
            ref={importFileRef}
            type="file"
            accept=".txt,text/plain"
            className="hidden"
            disabled={busy}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              try {
                setImportText(await file.text());
                setImportFileName(file.name);
                setImportFileError("");
              } catch {
                setImportFileName("");
                setImportFileError("文件读取失败，请重新选择或手动粘贴代理地址。");
              } finally {
                event.target.value = "";
              }
            }}
          />
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => importFileRef.current?.click()}>
            <FileUp size={16} /> 选择文件
          </Button>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {importFileName || "支持 TXT 文本文件；选择后仍可在下方编辑"}
          </span>
        </div>
        {importFileError && <p className="text-xs text-destructive">{importFileError}</p>}
        <textarea
          className="min-h-56 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          value={importText}
          disabled={busy}
          onChange={(event) => setImportText(event.target.value)}
          placeholder={"http://user:pass@1.2.3.4:8080\nsocks5://127.0.0.1:1080"}
        />
        <p className="text-xs text-muted-foreground">共 {importText.split(/\r?\n/).filter((line) => line.trim()).length} 个地址，导入数量不限。</p>
      </Modal>
    </div>
  );
}

function InfoCard({ icon, title, value, sub }: { icon: React.ReactNode; title: string; value: string; sub: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {title}
      </div>
      <strong className="mt-2 block truncate text-lg font-semibold">{value}</strong>
      <small className="text-xs text-muted-foreground/70">{sub}</small>
    </Card>
  );
}
