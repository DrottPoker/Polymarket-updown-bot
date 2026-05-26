import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AppConfig } from "../config/appConfig";
import { Candle, LiveOrder, OrderEvent, PaperTrade, ResolvedPaperTrade, StrategyDecision, TrendColor } from "../domain/types";

export const tradeCsvColumns = [
  "signal_time",
  "candle_open_time",
  "candle_close_time",
  "symbol",
  "direction",
  "entry_cents",
  "stake_usd",
  "shares",
  "open",
  "close",
  "result",
  "pnl",
  "reason",
  "kind",
  "market_slug",
  "polymarket_outcome",
  "token_id",
  "order_id",
  "live_status",
  "live_filled",
  "live_price",
  "live_size",
];
export const tradeCsvHeader = tradeCsvColumns.join(",");

export const statsCsvColumns = [
  "updated_at",
  "scope",
  "trades",
  "wins",
  "losses",
  "winrate_pct",
  "total_pnl",
  "avg_pnl",
  "total_stake",
  "avg_stake",
  "avg_entry_cents",
];
export const statsCsvHeader = statsCsvColumns.join(",");

export const orderEventCsvColumns = [
  "event_time",
  "event_type",
  "signal_time",
  "candle_open_time",
  "candle_close_time",
  "symbol",
  "direction",
  "kind",
  "entry_stage",
  "entry_cents",
  "stake_usd",
  "shares",
  "reason",
  "detail",
  "market_slug",
  "polymarket_outcome",
  "token_id",
  "order_id",
  "live_status",
  "live_filled",
  "filled_size",
  "live_price",
  "live_size",
  "canceled",
];
export const orderEventCsvHeader = orderEventCsvColumns.join(",");

export type CsvRow = Record<string, string>;

type StatsBucket = {
  scope: string;
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  stake: number;
  entryCents: number;
};

const sectionWidth = 78;

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function formatMoney(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}$${value.toFixed(2)}`;
}

function formatCandle(candle: Candle): string {
  const settlement = candle.settlement ?? "official";
  return `${toIso(candle.openTime)} ${candle.color} open=${candle.open.toFixed(2)} close=${candle.close.toFixed(
    2
  )} source=${settlement}`;
}

function formatTrendColors(colors: TrendColor[]): string {
  return colors.length > 0 ? colors.join(" -> ") : "none";
}

function formatDecision(decision: StrategyDecision): string {
  if (!decision.signal) {
    return `NO SIGNAL - ${decision.reason}`;
  }

  return `SIGNAL ${decision.signal.kind} ${decision.signal.direction} - ${decision.signal.reason}`;
}

function formatSectionHeader(title: string): string {
  const label = `[${title}]`;
  const prefix = "========== ";
  const usedLength = prefix.length + label.length + 1;
  const suffixLength = Math.max(10, sectionWidth - usedLength);
  return `${prefix}${label} ${"=".repeat(suffixLength)}`;
}

function logSection(title: string): void {
  console.log("");
  console.log(formatSectionHeader(title));
}

function logErrorSection(title: string): void {
  console.error("");
  console.error(formatSectionHeader(title));
}

function csvEscape(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(value);
      value = "";
      continue;
    }

    value += char;
  }

  values.push(value);
  return values;
}

function readCsvRows(file: string): CsvRow[] {
  const absolutePath = resolve(file);
  if (!existsSync(absolutePath)) {
    return [];
  }

  const lines = readFileSync(absolutePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    return [];
  }

  const columns = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return columns.reduce<CsvRow>((row, column, index) => {
      row[column] = values[index] ?? "";
      return row;
    }, {});
  });
}

function formatStatNumber(value: number, decimals = 2): number {
  return Number(value.toFixed(decimals));
}

function createBucket(scope: string): StatsBucket {
  return {
    scope,
    trades: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    stake: 0,
    entryCents: 0,
  };
}

function addTradeToBucket(bucket: StatsBucket, row: CsvRow): void {
  const result = row.result?.toUpperCase();
  if (result !== "WIN" && result !== "LOSS") {
    return;
  }

  bucket.trades += 1;
  bucket.wins += result === "WIN" ? 1 : 0;
  bucket.losses += result === "LOSS" ? 1 : 0;
  bucket.pnl += Number(row.pnl || 0);
  bucket.stake += Number(row.stake_usd || 0);
  bucket.entryCents += Number(row.entry_cents || 0);
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function isRealizedTradeRow(row: CsvRow): boolean {
  const orderId = row.order_id?.trim() ?? "";
  if (!orderId) {
    return true;
  }

  return isTruthy(row.live_filled);
}

function inferTradeKind(row: CsvRow): string {
  const kind = row.kind?.toUpperCase();
  if (kind === "BASE" || kind === "RETRY") {
    return kind;
  }

  const reason = row.reason?.toLowerCase() ?? "";
  if (reason.includes("retry")) {
    return "RETRY";
  }

  if (reason.includes("base")) {
    return "BASE";
  }

  return "";
}

function inferEntryStage(reason: string): string {
  const normalized = reason.toLowerCase();
  if (normalized.includes("primary early")) {
    return "Primary";
  }

  if (normalized.includes("secondary early")) {
    return "Secondary";
  }

  if (normalized.includes("final early")) {
    return "Final";
  }

  return "Regular";
}

function bucketToCsvRow(updatedAt: string, bucket: StatsBucket): Array<string | number> {
  const winrate = bucket.trades > 0 ? (bucket.wins / bucket.trades) * 100 : 0;
  const avgPnl = bucket.trades > 0 ? bucket.pnl / bucket.trades : 0;
  const avgStake = bucket.trades > 0 ? bucket.stake / bucket.trades : 0;
  const avgEntry = bucket.trades > 0 ? bucket.entryCents / bucket.trades : 0;

  return [
    updatedAt,
    bucket.scope,
    bucket.trades,
    bucket.wins,
    bucket.losses,
    formatStatNumber(winrate),
    formatStatNumber(bucket.pnl),
    formatStatNumber(avgPnl),
    formatStatNumber(bucket.stake),
    formatStatNumber(avgStake),
    formatStatNumber(avgEntry),
  ];
}

export function ensureCsvLog(logFile: string): void {
  const absolutePath = resolve(logFile);
  const directory = dirname(absolutePath);
  mkdirSync(directory, { recursive: true });

  if (!existsSync(absolutePath)) {
    appendFileSync(absolutePath, `${tradeCsvHeader}\n`, "utf8");
    return;
  }

  const existing = readFileSync(absolutePath, "utf8");
  const lines = existing.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0 || (lines.length === 1 && lines[0] !== tradeCsvHeader)) {
    writeFileSync(absolutePath, `${tradeCsvHeader}\n`, "utf8");
    return;
  }

  if (lines[0] !== tradeCsvHeader) {
    const existingColumns = parseCsvLine(lines[0]);
    const migratedRows = readCsvRows(logFile).map((row) =>
      tradeCsvColumns.map((column) => csvEscape(column === "kind" ? inferTradeKind(row) : row[column] ?? "")).join(",")
    );
    const unknownColumns = existingColumns.filter((column) => !tradeCsvColumns.includes(column));
    if (unknownColumns.length > 0) {
      throw new Error(`Cannot migrate ${logFile}; unknown CSV columns: ${unknownColumns.join(", ")}`);
    }

    writeFileSync(absolutePath, `${tradeCsvHeader}\n${migratedRows.join("\n")}${migratedRows.length > 0 ? "\n" : ""}`, "utf8");
  }
}

export function ensureOrderEventsCsvLog(logFile: string): void {
  const absolutePath = resolve(logFile);
  const directory = dirname(absolutePath);
  mkdirSync(directory, { recursive: true });

  if (!existsSync(absolutePath)) {
    appendFileSync(absolutePath, `${orderEventCsvHeader}\n`, "utf8");
    return;
  }

  const existing = readFileSync(absolutePath, "utf8");
  const lines = existing.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    writeFileSync(absolutePath, `${orderEventCsvHeader}\n`, "utf8");
    return;
  }

  if (lines[0] !== orderEventCsvHeader) {
    throw new Error(`Cannot use ${logFile}; order event CSV header does not match the current schema`);
  }
}

export function logStartup(config: AppConfig): void {
  logSection("START");
  console.log(`execution mode: ${config.executionMode}`);
  console.log(`price source: ${config.priceSource}`);
  console.log(`symbol: ${config.symbol}`);
  console.log(`interval: ${config.interval}`);
  console.log(`entry: ${config.entryCents}c`);
  console.log(`stake: $${config.stakeUsd}`);
  console.log(`window: first ${config.tradeWindowSeconds}s`);
  console.log(`ignore doji in trend: ${config.ignoreDojiInTrend}`);
  console.log(`loss retry logic: ${config.useLossRetryLogic}`);
  console.log(`retry wait candles: ${config.retryWaitCandles}`);
  console.log(`candle warmup limit: ${config.candleLimit}`);
  console.log(`early entry: ${config.earlyEntryEnabled}`);
  console.log(
    `early entry primary: ${config.earlyEntryPrimarySecondsBeforeClose}s / ${config.earlyEntryPrimaryMinMovePct}%`
  );
  console.log(
    `early entry secondary: ${config.earlyEntrySecondarySecondsBeforeClose}s / ${config.earlyEntrySecondaryMinMovePct}%`
  );
  console.log(`early entry final: ${config.earlyEntryOrderSecondsBeforeClose}s / color only`);
  console.log(`no-trade window: ${config.noTradeWindowEnabled}`);
  console.log(`no-trade hours: ${config.noTradeStart}-${config.noTradeEnd} ${config.noTradeTimeZone}`);
  if (config.priceSource === "polymarket_chainlink") {
    console.log(`chainlink symbol: ${config.polymarketAssetSlug}/usd`);
    console.log(`rtds: ${config.polymarketRtdsUrl}`);
  }
  if (config.executionMode !== "paper") {
    console.log(`polymarket asset: ${config.polymarketAssetSlug}`);
    console.log(`polymarket interval: ${config.polymarketIntervalSlug}`);
    console.log(`max entry: ${config.maxEntryCents}c`);
    console.log(`max stake: $${config.maxStakeUsd}`);
    console.log(`max daily loss: $${config.maxDailyLossUsd}`);
    console.log(`max trades/day: ${config.maxTradesPerDay}`);
    console.log(`max live window: ${config.maxLiveTradeWindowSeconds}s`);
    console.log(`live full-fill tolerance: ${config.liveFullFillToleranceShares} shares`);
  }
  console.log(`poll: ${config.pollMs}ms`);
  console.log(`local csv logging: ${config.localCsvLoggingEnabled}`);
  if (config.localCsvLoggingEnabled) {
    console.log(`log: ${config.logFile}`);
    console.log(`stats: ${config.statsFile}`);
    console.log(`order events: ${config.orderEventsFile}`);
  }
  console.log(`google sheets: ${config.googleSheetsEnabled}`);
  if (config.googleSheetsEnabled) {
    console.log(`google trades sheet: ${config.googleSheetsTradesSheetName}`);
    console.log(`google stats sheet: ${config.googleSheetsStatsSheetName}`);
    console.log(`google order events sheet: ${config.googleSheetsOrderEventsSheetName}`);
  }
}

export function logWarmup(closedCandles: number): void {
  logSection("WARMUP");
  console.log(`processed closed candles: ${closedCandles}`);
}

export function logRecentClosedCandles(candles: Candle[], trendColors: TrendColor[]): void {
  logSection("CANDLES");
  console.log("latest closed candles:");
  for (const candle of candles) {
    console.log(`  - ${formatCandle(candle)}`);
  }
  console.log(`last ${trendColors.length} trend colors (oldest -> newest): ${formatTrendColors(trendColors)}`);
}

export function logCandleDecision(
  closedCandle: Candle,
  trendColors: TrendColor[],
  decision: StrategyDecision,
  targetOpenTime: number
): void {
  logSection("CANDLE");
  console.log(`closed: ${formatCandle(closedCandle)}`);
  console.log(`last ${trendColors.length} trend colors (oldest -> newest): ${formatTrendColors(trendColors)}`);
  console.log(`next target: ${toIso(targetOpenTime)}`);
  console.log(`decision: ${formatDecision(decision)}`);
}

export function logCandleCorrection(previous: Candle, corrected: Candle): void {
  logSection("CANDLE_CORRECTION");
  console.log(`applies to: ${toIso(corrected.openTime)}`);
  console.log(`previous: ${formatCandle(previous)}`);
  console.log(`corrected: ${formatCandle(corrected)}`);
  console.log(`color: ${previous.color === corrected.color ? corrected.color : `${previous.color} -> ${corrected.color}`}`);
  console.log("note: official Gamma data can arrive after newer provisional candles");
}

export function logSignal(trade: PaperTrade, tradeWindowSeconds: number): void {
  logSection("SIGNAL");
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
  logSection("RESULT");
  console.log(`time: ${toIso(trade.candleOpenTime)}`);
  console.log(`type: ${trade.kind}`);
  console.log(`direction: ${trade.direction}`);
  console.log(`open: ${trade.open.toFixed(2)}`);
  console.log(`close: ${trade.close.toFixed(2)}`);
  console.log(`outcome: ${trade.result}`);
  console.log(`pnl: ${formatMoney(trade.pnl)}`);
}

export function logLiveOrder(order: LiveOrder): void {
  logSection("LIVE_ORDER");
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
  logSection("LIVE_DRY_RUN");
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
  logSection("LIVE_CANCEL");
  console.log(`market: ${order.marketSlug}`);
  console.log(`order id: ${order.orderId ?? "unknown"}`);
  console.log(`filled: ${order.filled}`);
  if (order.filledSize && order.filledSize > 0) {
    console.log(`filled size: ${order.filledSize.toFixed(4)} of ${order.size.toFixed(4)}`);
  }
}

export function logLiveFill(order: LiveOrder): void {
  logSection("LIVE_FILL");
  console.log(`market: ${order.marketSlug}`);
  console.log(`order id: ${order.orderId ?? "unknown"}`);
  console.log(`price: ${order.price.toFixed(4)}`);
  console.log(`size: ${order.size.toFixed(4)}`);
  console.log(`filled size: ${(order.filledSize ?? order.size).toFixed(4)}`);
}

export function logSkip(message: string): void {
  logSection("SKIP");
  console.log(message);
}

export function logError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logErrorSection("ERROR");
  console.error(message);
}

export function buildTradeResultRow(
  trade: ResolvedPaperTrade,
  liveOrder?: LiveOrder | null
): Array<string | number | boolean | null | undefined> {
  return [
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
    trade.kind,
    liveOrder?.marketSlug,
    liveOrder?.outcome,
    liveOrder?.tokenId,
    liveOrder?.orderId,
    liveOrder?.status,
    liveOrder?.filled,
    liveOrder?.price,
    liveOrder?.size,
  ];
}

export function buildOrderEventRow(event: OrderEvent): Array<string | number | boolean | null | undefined> {
  return [
    toIso(event.eventTime),
    event.eventType,
    toIso(event.trade.signalTime),
    toIso(event.trade.candleOpenTime),
    toIso(event.trade.candleCloseTime),
    event.trade.symbol,
    event.trade.direction,
    event.trade.kind,
    inferEntryStage(event.trade.reason),
    event.trade.entryCents,
    event.trade.stakeUsd,
    Number(event.trade.shares.toFixed(8)),
    event.trade.reason,
    event.detail,
    event.liveOrder?.marketSlug,
    event.liveOrder?.outcome,
    event.liveOrder?.tokenId,
    event.liveOrder?.orderId,
    event.liveOrder?.status,
    event.liveOrder?.filled,
    event.liveOrder?.filledSize,
    event.liveOrder?.price,
    event.liveOrder?.size,
    event.liveOrder?.canceled,
  ];
}

export function appendTradeResult(logFile: string, trade: ResolvedPaperTrade, liveOrder?: LiveOrder | null): void {
  const row = buildTradeResultRow(trade, liveOrder).map(csvEscape).join(",");
  appendFileSync(resolve(logFile), `${row}\n`, "utf8");
}

export function appendOrderEvent(logFile: string, event: OrderEvent): void {
  const row = buildOrderEventRow(event).map(csvEscape).join(",");
  appendFileSync(resolve(logFile), `${row}\n`, "utf8");
}

export function buildStatsCsvValuesFromRows(rows: CsvRow[]): Array<Array<string | number>> {
  const buckets = [
    createBucket("TOTAL"),
    createBucket("BASE"),
    createBucket("RETRY"),
    createBucket("UP"),
    createBucket("DOWN"),
    createBucket("BASE_UP"),
    createBucket("BASE_DOWN"),
    createBucket("RETRY_UP"),
    createBucket("RETRY_DOWN"),
  ];
  const bucketByScope = new Map(buckets.map((bucket) => [bucket.scope, bucket]));

  for (const row of rows) {
    if (!isRealizedTradeRow(row)) {
      continue;
    }

    const kind = inferTradeKind(row);
    const direction = row.direction?.toUpperCase();
    addTradeToBucket(bucketByScope.get("TOTAL") as StatsBucket, row);

    if (kind === "BASE" || kind === "RETRY") {
      addTradeToBucket(bucketByScope.get(kind) as StatsBucket, row);
    }

    if (direction === "UP" || direction === "DOWN") {
      addTradeToBucket(bucketByScope.get(direction) as StatsBucket, row);
    }

    if ((kind === "BASE" || kind === "RETRY") && (direction === "UP" || direction === "DOWN")) {
      addTradeToBucket(bucketByScope.get(`${kind}_${direction}`) as StatsBucket, row);
    }
  }

  const updatedAt = toIso(Date.now());
  return [statsCsvColumns, ...buckets.map((bucket) => bucketToCsvRow(updatedAt, bucket))];
}

export function buildStatsCsvValues(tradeLogFile: string): Array<Array<string | number>> {
  return buildStatsCsvValuesFromRows(readCsvRows(tradeLogFile));
}

export function refreshStatsLog(tradeLogFile: string, statsFile: string): void {
  const values = buildStatsCsvValues(tradeLogFile);
  const statsRows = values.map((row) => row.map(csvEscape).join(","));
  const absolutePath = resolve(statsFile);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${statsRows.join("\n")}\n`, "utf8");
}
