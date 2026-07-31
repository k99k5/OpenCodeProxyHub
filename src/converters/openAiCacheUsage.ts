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

interface ParsedSseBlock {
  data: string;
  dataIndexes: number[];
  lines: string[];
  newline: string;
}

const parseSseBlock = (block: string): ParsedSseBlock | undefined => {
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

  if (dataIndexes.length === 0) return undefined;
  return {
    data: dataLines.join("\n"),
    dataIndexes,
    lines,
    newline,
  };
};

const replaceSseData = (
  block: ParsedSseBlock,
  payload: unknown,
): string => {
  const firstDataIndex = block.dataIndexes[0]!;
  const remainingDataIndexes = new Set(block.dataIndexes.slice(1));
  return block.lines
    .filter((_, index) => !remainingDataIndexes.has(index))
    .map((line, index) =>
      index === firstDataIndex ? `data: ${JSON.stringify(payload)}` : line,
    )
    .join(block.newline);
};

const renderSseData = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}`;

/**
 * Moves stream usage into a standalone OpenAI-compatible `choices: []` chunk.
 * The most recent usage payload is held until the stream terminates.
 */
export class OpenAiStreamUsageNormalizer {
  private pendingUsage: JsonObject | undefined;

  push(payload: unknown): unknown[] {
    const parsed = asObject(payload);
    const usage = asObject(parsed?.usage);
    if (!parsed || !usage) return [payload];

    applyOpenAiCacheUsageFallback(parsed);
    this.pendingUsage = {
      ...parsed,
      choices: [],
      usage,
    };

    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    if (choices.length === 0) return [];

    return [{ ...parsed, usage: null }];
  }

  finish(): unknown | undefined {
    const pendingUsage = this.pendingUsage;
    this.pendingUsage = undefined;
    return pendingUsage;
  }
}

export class OpenAiCacheUsageSseRewriter {
  private buffer = "";
  private done = false;
  private readonly decoder = new StringDecoder("utf8");
  private readonly usageNormalizer = new OpenAiStreamUsageNormalizer();

  push(chunk: string | Buffer): string {
    if (this.done) return "";
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let output = "";

    while (true) {
      const delimiter = this.buffer.match(/\r?\n\r?\n/);
      if (!delimiter || delimiter.index === undefined) break;

      const delimiterEnd = delimiter.index + delimiter[0].length;
      output += this.rewriteSseBlock(
        this.buffer.slice(0, delimiter.index),
        delimiter[0],
      );
      this.buffer = this.buffer.slice(delimiterEnd);
    }

    if (this.done) this.buffer = "";
    return output;
  }

  flush(): string {
    this.buffer += this.decoder.end();
    const remaining = this.buffer;
    this.buffer = "";
    let output = remaining ? this.rewriteSseBlock(remaining, "") : "";
    if (this.done) return output;

    const pendingUsage = this.usageNormalizer.finish();
    if (pendingUsage === undefined) return output;

    if (output && !/\r?\n\r?\n$/.test(output)) output += "\n\n";
    return `${output}${renderSseData(pendingUsage)}\n\n`;
  }

  private rewriteSseBlock(block: string, delimiter: string): string {
    if (this.done) return "";

    const parsedBlock = parseSseBlock(block);
    if (!parsedBlock) return block + delimiter;

    if (parsedBlock.data.trim() === "[DONE]") {
      this.done = true;
      const pendingUsage = this.usageNormalizer.finish();
      const usageBlock =
        pendingUsage === undefined
          ? ""
          : `${renderSseData(pendingUsage)}${delimiter || `${parsedBlock.newline}${parsedBlock.newline}`}`;
      return `${usageBlock}${block}${delimiter}`;
    }

    try {
      const payloads = this.usageNormalizer.push(
        JSON.parse(parsedBlock.data),
      );
      return payloads
        .map(
          (payload, index) =>
            `${
              index === 0
                ? replaceSseData(parsedBlock, payload)
                : renderSseData(payload)
            }${delimiter}`,
        )
        .join("");
    } catch {
      return block + delimiter;
    }
  }
}
