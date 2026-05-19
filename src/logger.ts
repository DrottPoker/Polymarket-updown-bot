import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AppConfig } from "./config";
import { LiveOrder, PaperTrade, ResolvedPaperTrade } from "./types";

const csvHeader =
  "signal_time,candle_open_time,candle_close_time,symbol,direction,entry_cents,stake_usd,shares,open,close,result,pnl,reason";

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function formatMoney(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}$${value.toFixed(2)}`;
}

function csvEscape(value: string | number): string {
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function ensureCsvLog(logFile: string): void {
  const absolutePath = resolve(logFile);
  const directory = dirname(absolutePath);
  mkdirSync(directory, { recursive: true });

  if (!existsSync(absolutePath)) {
    appendFileSync(absolutePath, `${csvHeader}\n`, "utf8");
    return;
  }

  const existing = readFileSync(absolutePath, "utf8");
  const lines = existing.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0 || (lines.length === 1 && lines[0] !== csvHeader)) {
    writeFileSync(absolutePath, `${csvHeader}\n`, "utf8");
  }
}

export function logStartup(config: AppConfig): void {
  console.log("[START]");
  console.log(`execution mode: ${config.executionMode}`);
  console.log(`symbol: ${config.symbol}`);
  console.log(`interval: ${config.interval}`);
  console.log(`entry: ${config.entryCents}c`);
  console.log(`stake: $${config.stakeUsd}`);
  console.log(`ev stake: $${config.evStakeUsd}`);
  console.log(`window: first ${config.tradeWindowSeconds}s`);
  console.log(`ignore doji in trend: ${config.ignoreDojiInTrend}`);
  console.log(`loss retry logic: ${config.useLossRetryLogic}`);
  console.log(`retry wait candles: ${config.retryWaitCandles}`);
  console.log(`candle warmup limit: ${config.candleLimit}`);
  console.log(`early entry: ${config.earlyEntryEnabled}`);
  console.log(`early entry seconds: ${config.earlyEntrySecondsBeforeClose}`);
  console.log(`early entry min move: ${config.earlyEntryMinMovePct}%`);
  if (config.executionMode !== "paper") {
    console.log(`polymarket asset: ${config.polymarketAssetSlug}`);
    console.log(`polymarket interval: ${config.polymarketIntervalSlug}`);
    console.log(`max entry: ${config.maxEntryCents}c`);
    console.log(`max stake: $${config.maxStakeUsd}`);
    console.log(`max daily loss: $${config.maxDailyLossUsd}`);
    console.log(`max trades/day: ${config.maxTradesPerDay}`);
    console.log(`max live window: ${config.maxLiveTradeWindowSeconds}s`);
  }
  console.log(`poll: ${config.pollMs}ms`);
  console.log(`log: ${config.logFile}`);
}

export function logWarmup(closedCandles: number): void {
  console.log("");
  console.log("[WARMUP]");
  console.log(`processed closed candles: ${closedCandles}`);
}

export function logSignal(trade: PaperTrade, tradeWindowSeconds: number): void {
  console.log("");
  console.log("[SIGNAL]");
  console.log(`time: ${toIso(trade.signalTime)}`);
  console.log(`type: ${trade.kind}`);
  console.log(`direction: ${trade.direction}`);
  console.log(`reason: ${trade.reason}`);
  console.log(`entry: ${trade.entryCents}c`);
  console.log(`stake: $${trade.stakeUsd}`);
  console.log(`shares: ${trade.shares.toFixed(4)}`);
  console.log(`window: first ${tradeWindowSeconds}s`);
}

export function logResult(trade: ResolvedPaperTrade): void {
  console.log("");
  console.log("[RESULT]");
  console.log(`time: ${toIso(trade.candleOpenTime)}`);
  console.log(`type: ${trade.kind}`);
  console.log(`direction: ${trade.direction}`);
  console.log(`open: ${trade.open.toFixed(2)}`);
  console.log(`close: ${trade.close.toFixed(2)}`);
  console.log(`outcome: ${trade.result}`);
  console.log(`pnl: ${formatMoney(trade.pnl)}`);
}

export function logLiveOrder(order: LiveOrder): void {
  console.log("");
  console.log("[LIVE_ORDER]");
  console.log(`market: ${order.marketSlug}`);
  console.log(`outcome: ${order.outcome}`);
  console.log(`token: ${order.tokenId}`);
  console.log(`price: ${order.price.toFixed(4)}`);
  console.log(`size: ${order.size.toFixed(4)}`);
  console.log(`tick size: ${order.tickSize}`);
  console.log(`min order size: ${order.minOrderSize}`);
  console.log(`neg risk: ${order.negRisk}`);
  console.log(`order id: ${order.orderId ?? "unknown"}`);
  console.log(`status: ${order.status ?? "unknown"}`);
  console.log(`filled: ${order.filled}`);
  console.log(`cancel at: ${toIso(order.cancelAt)}`);
}

export function logLiveDryRun(order: LiveOrder): void {
  console.log("");
  console.log("[LIVE_DRY_RUN]");
  console.log("no order was posted");
  console.log(`market: ${order.marketSlug}`);
  console.log(`outcome: ${order.outcome}`);
  console.log(`token: ${order.tokenId}`);
  console.log(`side: BUY`);
  console.log(`price: ${order.price.toFixed(4)}`);
  console.log(`size: ${order.size.toFixed(4)}`);
  console.log(`tick size: ${order.tickSize}`);
  console.log(`min order size: ${order.minOrderSize}`);
  console.log(`neg risk: ${order.negRisk}`);
  console.log(`would cancel at: ${toIso(order.cancelAt)}`);
}

export function logLiveCancel(order: LiveOrder): void {
  console.log("");
  console.log("[LIVE_CANCEL]");
  console.log(`market: ${order.marketSlug}`);
  console.log(`order id: ${order.orderId ?? "unknown"}`);
  console.log(`filled: ${order.filled}`);
}

export function logSkip(message: string): void {
  console.log("");
  console.log("[SKIP]");
  console.log(message);
}

export function logError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error("");
  console.error("[ERROR]");
  console.error(message);
}

export function appendTradeResult(logFile: string, trade: ResolvedPaperTrade): void {
  const row = [
    toIso(trade.signalTime),
    toIso(trade.candleOpenTime),
    toIso(trade.candleCloseTime),
    trade.symbol,
    trade.direction,
    trade.entryCents,
    trade.stakeUsd,
    Number(trade.shares.toFixed(8)),
    trade.open,
    trade.close,
    trade.result,
    Number(trade.pnl.toFixed(8)),
    trade.reason,
  ]
    .map(csvEscape)
    .join(",");

  appendFileSync(resolve(logFile), `${row}\n`, "utf8");
}
