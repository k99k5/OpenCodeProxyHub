import { StringDecoder } from "node:string_decoder";

const FALLBACK_CACHE_RATIO = 0.9;

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const asTokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/**
 * Keeps a positive upstream cached-token count. When it is absent, invalid, or
 * zero, reports 90% of the prompt tokens as cached.
 */
export const applyOpenAiCacheUsageFallback = (payload: unknown): boolean => {
  const usage = asObject(asObject(payload)?.usage);
  if (!usage) return false;

  const promptTokens = asTokenCount(usage.prompt_tokens);
  if (promptTokens === undefined) return false;

  const promptDetails = asObject(usage.prompt_tokens_details);
  const upstreamCachedTokens = asTokenCount(promptDetails?.cached_tokens);
  if (upstreamCachedTokens !== undefined && upstreamCachedTokens > 0)
    return false;

  const cachedTokens = Math.round(promptTokens * FALLBACK_CACHE_RATIO);
  if (promptDetails?.cached_tokens === cachedTokens) return false;

  usage.prompt_tokens_details = {
    ...(promptDetails || {}),
    cached_tokens: cachedTokens,
  };
  return true;
};

export const rewriteOpenAiJsonCacheUsage = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw);
    return applyOpenAiCacheUsageFallback(parsed) ? JSON.stringify(parsed) : raw;
  } catch {
    return raw;
  }
};

const rewriteSseBlock = (block: string): string => {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const dataIndexes: number[] = [];
  const dataLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.startsWith("data:")) continue;
    dataIndexes.push(index);
    dataLines.push(line.slice(5).replace(/^ /, ""));
  }

  if (dataIndexes.length === 0) return block;
  const data = dataLines.join("\n");
  if (data.trim() === "[DONE]") return block;

  try {
    const parsed = JSON.parse(data);
    if (!applyOpenAiCacheUsageFallback(parsed)) return block;

    const firstDataIndex = dataIndexes[0]!;
    const remainingDataIndexes = new Set(dataIndexes.slice(1));
    return lines
      .filter((_, index) => !remainingDataIndexes.has(index))
      .map((line, index) =>
        index === firstDataIndex ? `data: ${JSON.stringify(parsed)}` : line,
      )
      .join(newline);
  } catch {
    return block;
  }
};

export class OpenAiCacheUsageSseRewriter {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");

  push(chunk: string | Buffer): string {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let output = "";

    while (true) {
      const delimiter = this.buffer.match(/\r?\n\r?\n/);
      if (!delimiter || delimiter.index === undefined) break;

      const delimiterEnd = delimiter.index + delimiter[0].length;
      output += rewriteSseBlock(this.buffer.slice(0, delimiter.index));
      output += delimiter[0];
      this.buffer = this.buffer.slice(delimiterEnd);
    }

    return output;
  }

  flush(): string {
    this.buffer += this.decoder.end();
    const remaining = this.buffer;
    this.buffer = "";
    return rewriteSseBlock(remaining);
  }
}
