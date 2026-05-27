import { loadConfig } from "../config/appConfig";
import { Direction, TradeResult } from "../domain/types";
import { GoogleSheetsLogger } from "../logging/googleSheetsLogger";
import { CsvRow } from "../logging/logger";

type Stage = "Primary" | "Secondary" | "Final" | "Regular" | "Other";

type Metrics = {
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  grossPnl: number;
  stake: number;
  fees: number;
  entryCents: number;
};

type SimulatedTrade = {
  stage: Stage;
  direction: Direction;
  reverseDirection: Direction;
  originalResult: TradeResult;
  reverseResult: TradeResult;
  originalPnl: number;
  reverseGrossPnl: number;
  reverseNetPnl: number;
  entryCents: number;
  stakeUsd: number;
  feeUsd: number;
};

const helpFlags = new Set(["--help", "-h", "help"]);

function shouldPrintHelp(): boolean {
  return process.argv.slice(2).some((argument) => helpFlags.has(argument));
}

function printHelp(): void {
  console.log("Reverse BASE simulation from Google Sheets");
  console.log("");
  console.log("Usage:");
  console.log("  npm run simulate:reverse-base");
  console.log("  npm run simulate:reverse-base:help");
  console.log("");
  console.log("What it does:");
  console.log("  - Reads realized rows from the configured Google Sheets Trades tab.");
  console.log("  - Includes only rows where kind=BASE.");
  console.log("  - Excludes all RETRY rows.");
  console.log("  - Simulates the opposite direction using the logged open, close, entry, stake, and shares.");
  console.log("  - Prints original BASE performance next to reversed BASE performance.");
  console.log("  - Does not edit Google Sheets, local CSV files, runtime state, or config.");
  console.log("");
  console.log("Assumption:");
  console.log("  - Reversed net PnL reuses the logged fee_usd as a fee estimate. Gross PnL is shown separately.");
}

function parseNumber(value: string | undefined): number {
  const parsed = Number((value ?? "").replace(/[$,]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseDirection(value: string | undefined): Direction | null {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized === "UP" || normalized === "DOWN" ? normalized : null;
}

function parseResult(value: string | undefined): TradeResult | null {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized === "WIN" || normalized === "LOSS" ? normalized : null;
}

function oppositeDirection(direction: Direction): Direction {
  return direction === "UP" ? "DOWN" : "UP";
}

function settle(direction: Direction, open: number, close: number): TradeResult {
  if (direction === "UP" && close > open) {
    return "WIN";
  }

  if (direction === "DOWN" && close < open) {
    return "WIN";
  }

  return "LOSS";
}

function inferStage(reason: string | undefined): Stage {
  const normalized = (reason ?? "").toLowerCase();
  if (normalized.includes("primary")) {
    return "Primary";
  }

  if (normalized.includes("secondary")) {
    return "Secondary";
  }

  if (normalized.includes("final")) {
    return "Final";
  }

  if (normalized.includes("base setup")) {
    return "Regular";
  }

  return "Other";
}

function emptyMetrics(): Metrics {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    grossPnl: 0,
    stake: 0,
    fees: 0,
    entryCents: 0,
  };
}

function addOriginal(metrics: Metrics, trade: SimulatedTrade): void {
  metrics.trades += 1;
  metrics.wins += trade.originalResult === "WIN" ? 1 : 0;
  metrics.losses += trade.originalResult === "LOSS" ? 1 : 0;
  metrics.pnl += trade.originalPnl;
  metrics.grossPnl += trade.originalPnl + trade.feeUsd;
  metrics.stake += trade.stakeUsd;
  metrics.fees += trade.feeUsd;
  metrics.entryCents += trade.entryCents;
}

function addReverse(metrics: Metrics, trade: SimulatedTrade): void {
  metrics.trades += 1;
  metrics.wins += trade.reverseResult === "WIN" ? 1 : 0;
  metrics.losses += trade.reverseResult === "LOSS" ? 1 : 0;
  metrics.pnl += trade.reverseNetPnl;
  metrics.grossPnl += trade.reverseGrossPnl;
  metrics.stake += trade.stakeUsd;
  metrics.fees += trade.feeUsd;
  metrics.entryCents += trade.entryCents;
}

function winrate(metrics: Metrics): number {
  return metrics.trades > 0 ? (metrics.wins / metrics.trades) * 100 : 0;
}

function roi(metrics: Metrics): number {
  return metrics.stake > 0 ? (metrics.pnl / metrics.stake) * 100 : 0;
}

function averageEntryCents(metrics: Metrics): number {
  return metrics.trades > 0 ? metrics.entryCents / metrics.trades : 0;
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
    `${label.padEnd(12)} trades=${metrics.trades.toString().padStart(3)} wins=${metrics.wins
      .toString()
      .padStart(3)} losses=${metrics.losses.toString().padStart(3)} winrate=${formatPct(winrate(metrics)).padStart(
      6
    )} net=${formatMoney(metrics.pnl).padStart(9)} gross=${formatMoney(metrics.grossPnl).padStart(
      9
    )} fees=${formatMoney(metrics.fees).padStart(8)} roi=${formatPct(roi(metrics)).padStart(
      7
    )} avg_entry=${averageEntryCents(metrics).toFixed(2)}c`
  );
}

function simulateRow(row: CsvRow): SimulatedTrade | null {
  if ((row.kind ?? "").trim().toUpperCase() !== "BASE") {
    return null;
  }

  const direction = parseDirection(row.direction);
  const originalResult = parseResult(row.result);
  const open = parseNumber(row.open);
  const close = parseNumber(row.close);
  const entryCents = parseNumber(row.entry_cents);
  const stakeUsd = parseNumber(row.stake_usd);
  const loggedShares = parseNumber(row.shares);
  const feeUsd = parseNumber(row.fee_usd);

  if (!direction || !originalResult || open <= 0 || close <= 0 || entryCents <= 0 || stakeUsd <= 0) {
    return null;
  }

  const entryDecimal = entryCents / 100;
  const shares = loggedShares > 0 ? loggedShares : stakeUsd / entryDecimal;
  const reverseDirection = oppositeDirection(direction);
  const reverseResult = settle(reverseDirection, open, close);
  const reverseGrossPnl = reverseResult === "WIN" ? shares - stakeUsd : -stakeUsd;

  return {
    stage: inferStage(row.reason),
    direction,
    reverseDirection,
    originalResult,
    reverseResult,
    originalPnl: parseNumber(row.pnl),
    reverseGrossPnl,
    reverseNetPnl: reverseGrossPnl - feeUsd,
    entryCents,
    stakeUsd,
    feeUsd,
  };
}

function summarizeByStage(trades: SimulatedTrade[]): Map<Stage, { original: Metrics; reverse: Metrics }> {
  const stages: Stage[] = ["Primary", "Secondary", "Final", "Regular", "Other"];
  const summary = new Map<Stage, { original: Metrics; reverse: Metrics }>();
  for (const stage of stages) {
    summary.set(stage, { original: emptyMetrics(), reverse: emptyMetrics() });
  }

  for (const trade of trades) {
    const metrics = summary.get(trade.stage);
    if (!metrics) {
      continue;
    }

    addOriginal(metrics.original, trade);
    addReverse(metrics.reverse, trade);
  }

  return summary;
}

async function main(): Promise<void> {
  if (shouldPrintHelp()) {
    printHelp();
    return;
  }

  const config = loadConfig();
  if (!config.googleSheetsEnabled) {
    throw new Error("googleSheetsEnabled must be true before reading Google Sheets trades");
  }

  const logger = new GoogleSheetsLogger(config);
  const rows = await logger.readTradeRows();
  const simulatedTrades = rows.flatMap((row) => {
    const trade = simulateRow(row);
    return trade ? [trade] : [];
  });
  const retryRows = rows.filter((row) => (row.kind ?? "").trim().toUpperCase() === "RETRY").length;
  const skippedRows = rows.length - simulatedTrades.length - retryRows;

  const original = emptyMetrics();
  const reverse = emptyMetrics();
  for (const trade of simulatedTrades) {
    addOriginal(original, trade);
    addReverse(reverse, trade);
  }

  console.log("[REVERSE_BASE_SIM]");
  console.log(`spreadsheet: ${config.googleSheetsSpreadsheetId}`);
  console.log(`trades sheet: ${config.googleSheetsTradesSheetName}`);
  console.log(`source rows: ${rows.length}`);
  console.log(`base rows simulated: ${simulatedTrades.length}`);
  console.log(`retry rows excluded: ${retryRows}`);
  console.log(`other rows skipped: ${skippedRows}`);
  console.log("");
  console.log("Assumption: reverse uses the same logged entry, stake, shares, and fee_usd estimate.");
  console.log("");
  printMetrics("Original", original);
  printMetrics("Reversed", reverse);
  console.log(
    `Delta        winrate=${formatPct(winrate(reverse) - winrate(original)).padStart(6)} net=${formatMoney(
      reverse.pnl - original.pnl
    ).padStart(9)}`
  );

  console.log("");
  console.log("By stage:");
  const byStage = summarizeByStage(simulatedTrades);
  for (const [stage, metrics] of byStage.entries()) {
    if (metrics.original.trades === 0) {
      continue;
    }

    printMetrics(`${stage} orig`, metrics.original);
    printMetrics(`${stage} rev`, metrics.reverse);
  }
}

void main().catch((error) => {
  console.error("");
  console.error("[ERROR]");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
