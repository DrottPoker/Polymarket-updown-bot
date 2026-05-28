import { loadConfig } from "../config/appConfig";
import { Candle, CandleColor, Direction, TradeResult, TrendColor } from "../domain/types";
import { GoogleSheetsLogger } from "../logging/googleSheetsLogger";
import { CsvRow } from "../logging/logger";

type SetupKind = "three_green" | "three_red";

type Metrics = {
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  stake: number;
};

type BacktestTrade = {
  targetOpenTime: number;
  setup: SetupKind;
  originalDirection: Direction;
  reverseDirection: Direction;
  originalResult: TradeResult;
  reverseResult: TradeResult;
  originalPnl: number;
  reversePnl: number;
};

const helpFlags = new Set(["--help", "-h", "help"]);
const officialOnlyFlags = new Set(["--official-only"]);

function shouldPrintHelp(): boolean {
  return process.argv.slice(2).some((argument) => helpFlags.has(argument));
}

function shouldUseOfficialOnly(): boolean {
  return process.argv.slice(2).some((argument) => officialOnlyFlags.has(argument));
}

function printHelp(): void {
  console.log("Reverse BASE candle backtest from Google Sheets");
  console.log("");
  console.log("Usage:");
  console.log("  npm run backtest:reverse-base-candles");
  console.log("  npm run backtest:reverse-base-candles:official");
  console.log("  npm run backtest:reverse-base-candles:help");
  console.log("");
  console.log("What it does:");
  console.log("  - Reads closed candles from the configured Google Sheets Candles tab.");
  console.log("  - Builds candle-close BASE signals from the previous three trend candles.");
  console.log("  - Excludes RETRY logic entirely.");
  console.log("  - Simulates original BASE direction and reversed BASE direction on the next candle.");
  console.log("  - Uses configured entryCents and stakeUsd, with no fee estimate.");
  console.log("  - Does not edit Google Sheets, local CSV files, runtime state, or config.");
  console.log("");
  console.log("Limitation:");
  console.log("  - This is a closed-candle backtest. It does not simulate 15s, 5s, or 1s early-entry timing.");
}

function parseNumber(value: string | undefined): number {
  const parsed = Number((value ?? "").replace(/[$,]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseBoolean(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function parseCandleColor(value: string | undefined, open: number, close: number): CandleColor {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "green" || normalized === "red" || normalized === "doji") {
    return normalized;
  }

  if (close > open) {
    return "green";
  }

  if (close < open) {
    return "red";
  }

  return "doji";
}

function rowToCandle(row: CsvRow): Candle | null {
  const openTime = parseNumber(row.open_time_ms) || Date.parse(row.open_time ?? "");
  const closeTime = parseNumber(row.close_time_ms) || Date.parse(row.close_time ?? "");
  const open = parseNumber(row.open);
  const high = parseNumber(row.high);
  const low = parseNumber(row.low);
  const close = parseNumber(row.close);

  if (
    !Number.isFinite(openTime) ||
    !Number.isFinite(closeTime) ||
    openTime <= 0 ||
    closeTime <= 0 ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0
  ) {
    return null;
  }

  return {
    openTime,
    closeTime,
    open,
    high,
    low,
    close,
    color: parseCandleColor(row.color, open, close),
    settlement: parseBoolean(row.is_official) ? "official" : "provisional",
  };
}

function trendColor(candle: Candle): TrendColor {
  return candle.color;
}

function previousTrendColors(candles: Candle[], beforeIndex: number, count: number, ignoreDoji: boolean): TrendColor[] {
  const colors: TrendColor[] = [];

  for (let index = beforeIndex - 1; index >= 0 && colors.length < count; index -= 1) {
    const color = trendColor(candles[index]);
    if (color === "doji" && ignoreDoji) {
      continue;
    }

    colors.push(color);
  }

  return colors.reverse();
}

function oppositeDirection(direction: Direction): Direction {
  return direction === "UP" ? "DOWN" : "UP";
}

function settle(direction: Direction, candle: Candle): TradeResult {
  if (direction === "UP" && candle.close > candle.open) {
    return "WIN";
  }

  if (direction === "DOWN" && candle.close < candle.open) {
    return "WIN";
  }

  return "LOSS";
}

function pnlForResult(result: TradeResult, stakeUsd: number, entryCents: number): number {
  if (result === "LOSS") {
    return -stakeUsd;
  }

  const entryDecimal = entryCents / 100;
  const shares = stakeUsd / entryDecimal;
  return shares - stakeUsd;
}

function emptyMetrics(): Metrics {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    stake: 0,
  };
}

function addTrade(metrics: Metrics, result: TradeResult, pnl: number, stakeUsd: number): void {
  metrics.trades += 1;
  metrics.wins += result === "WIN" ? 1 : 0;
  metrics.losses += result === "LOSS" ? 1 : 0;
  metrics.pnl += pnl;
  metrics.stake += stakeUsd;
}

function winrate(metrics: Metrics): number {
  return metrics.trades > 0 ? (metrics.wins / metrics.trades) * 100 : 0;
}

function roi(metrics: Metrics): number {
  return metrics.stake > 0 ? (metrics.pnl / metrics.stake) * 100 : 0;
}

function formatMoney(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}$${value.toFixed(2)}`;
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function printMetrics(label: string, metrics: Metrics): void {
  console.log(
    `${label.padEnd(14)} trades=${metrics.trades.toString().padStart(4)} wins=${metrics.wins
      .toString()
      .padStart(4)} losses=${metrics.losses.toString().padStart(4)} winrate=${formatPct(winrate(metrics)).padStart(
      6
    )} net=${formatMoney(metrics.pnl).padStart(10)} roi=${formatPct(roi(metrics)).padStart(8)}`
  );
}

function backtest(candles: Candle[], stakeUsd: number, entryCents: number, ignoreDoji: boolean): BacktestTrade[] {
  const trades: BacktestTrade[] = [];

  for (let targetIndex = 0; targetIndex < candles.length; targetIndex += 1) {
    const colors = previousTrendColors(candles, targetIndex, 3, ignoreDoji);
    if (colors.length < 3) {
      continue;
    }

    const threeGreen = colors.every((color) => color === "green");
    const threeRed = colors.every((color) => color === "red");
    if (!threeGreen && !threeRed) {
      continue;
    }

    const targetCandle = candles[targetIndex];
    const setup: SetupKind = threeGreen ? "three_green" : "three_red";
    const originalDirection: Direction = threeGreen ? "DOWN" : "UP";
    const reverseDirection = oppositeDirection(originalDirection);
    const originalResult = settle(originalDirection, targetCandle);
    const reverseResult = settle(reverseDirection, targetCandle);

    trades.push({
      targetOpenTime: targetCandle.openTime,
      setup,
      originalDirection,
      reverseDirection,
      originalResult,
      reverseResult,
      originalPnl: pnlForResult(originalResult, stakeUsd, entryCents),
      reversePnl: pnlForResult(reverseResult, stakeUsd, entryCents),
    });
  }

  return trades;
}

function summarize(trades: BacktestTrade[], stakeUsd: number): {
  original: Metrics;
  reverse: Metrics;
  threeGreenReverse: Metrics;
  threeRedReverse: Metrics;
} {
  const original = emptyMetrics();
  const reverse = emptyMetrics();
  const threeGreenReverse = emptyMetrics();
  const threeRedReverse = emptyMetrics();

  for (const trade of trades) {
    addTrade(original, trade.originalResult, trade.originalPnl, stakeUsd);
    addTrade(reverse, trade.reverseResult, trade.reversePnl, stakeUsd);
    addTrade(
      trade.setup === "three_green" ? threeGreenReverse : threeRedReverse,
      trade.reverseResult,
      trade.reversePnl,
      stakeUsd
    );
  }

  return {
    original,
    reverse,
    threeGreenReverse,
    threeRedReverse,
  };
}

async function main(): Promise<void> {
  if (shouldPrintHelp()) {
    printHelp();
    return;
  }

  const config = loadConfig();
  if (!config.googleSheetsEnabled) {
    throw new Error("googleSheetsEnabled must be true before reading Google Sheets candles");
  }

  const logger = new GoogleSheetsLogger(config);
  const rows = await logger.readCandleRows();
  const officialOnly = shouldUseOfficialOnly();
  const candlesByOpenTime = new Map<number, Candle>();
  let provisionalRows = 0;
  let skippedRows = 0;

  for (const row of rows) {
    const candle = rowToCandle(row);
    if (!candle) {
      skippedRows += 1;
      continue;
    }

    if (candle.settlement !== "official") {
      provisionalRows += 1;
      if (officialOnly) {
        continue;
      }
    }

    candlesByOpenTime.set(candle.openTime, candle);
  }

  const candles = Array.from(candlesByOpenTime.values()).sort((a, b) => a.openTime - b.openTime);
  const trades = backtest(candles, config.stakeUsd, config.entryCents, config.ignoreDojiInTrend);
  const summary = summarize(trades, config.stakeUsd);

  console.log("[REVERSE_BASE_CANDLE_BACKTEST]");
  console.log(`spreadsheet: ${config.googleSheetsSpreadsheetId}`);
  console.log(`candles sheet: ${config.googleSheetsCandlesSheetName}`);
  console.log(`source rows: ${rows.length}`);
  console.log(`candles used: ${candles.length}`);
  console.log(`provisional rows ${officialOnly ? "excluded" : "included"}: ${provisionalRows}`);
  console.log(`rows skipped: ${skippedRows}`);
  console.log(`entry: ${config.entryCents}c`);
  console.log(`stake: $${config.stakeUsd}`);
  console.log(`ignore doji in trend: ${config.ignoreDojiInTrend}`);
  console.log("");
  console.log("Closed-candle BASE-only backtest. RETRY and early-entry timing are not simulated.");
  console.log("");
  printMetrics("Original BASE", summary.original);
  printMetrics("Reversed BASE", summary.reverse);
  console.log(
    `Delta          winrate=${formatPct(winrate(summary.reverse) - winrate(summary.original)).padStart(
      6
    )} net=${formatMoney(summary.reverse.pnl - summary.original.pnl).padStart(10)}`
  );
  console.log("");
  console.log("Reversed by setup:");
  printMetrics("After 3 green", summary.threeGreenReverse);
  printMetrics("After 3 red", summary.threeRedReverse);
}

void main().catch((error) => {
  console.error("");
  console.error("[ERROR]");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
