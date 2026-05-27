import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../config/appConfig";
import { GoogleSheetsLogger } from "../logging/googleSheetsLogger";
import { orderEventCsvHeader, refreshStatsLog, tradeCsvHeader } from "../logging/logger";
import { RuntimeState, RuntimeStateStore } from "../state/runtimeStateStore";

const helpFlags = new Set(["--help", "-h", "help"]);
const dryRunFlags = new Set(["--dry-run", "--check", "check"]);
const confirmFlags = new Set(["--confirm", "confirm"]);
const preservedSheetNames = ["Setup", "Dashboard", "Advanced Stats", "Analysis Data"];

type ResetTarget = {
  target: string;
  action: string;
};

function shouldPrintHelp(): boolean {
  return process.argv.slice(2).some((argument) => helpFlags.has(argument));
}

function shouldDryRun(): boolean {
  return process.argv.slice(2).some((argument) => dryRunFlags.has(argument));
}

function isConfirmed(): boolean {
  return process.argv.slice(2).some((argument) => confirmFlags.has(argument));
}

function emptyRuntimeState(): RuntimeState {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    risk: null,
    pendingLiveTrade: null,
    pendingSettlements: [],
  };
}

function writeTextFile(file: string, contents: string): void {
  const absolutePath = resolve(file);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, "utf8");
}

function buildLocalTargets(config: ReturnType<typeof loadConfig>): ResetTarget[] {
  return [
    {
      target: config.logFile,
      action: "rewrite to the current Trades CSV header only",
    },
    {
      target: config.orderEventsFile,
      action: "rewrite to the current Order Events CSV header only",
    },
    {
      target: config.statsFile,
      action: "rebuild from the now-empty Trades CSV",
    },
    {
      target: config.runtimeStateFile,
      action: "reset risk counters and pending live order state",
    },
  ];
}

function buildSheetTargets(config: ReturnType<typeof loadConfig>): ResetTarget[] {
  if (!config.googleSheetsEnabled) {
    return [];
  }

  return [
    {
      target: `${config.googleSheetsTradesSheetName}`,
      action: "clear rows and rewrite the current Trades header",
    },
    {
      target: `${config.googleSheetsOrderEventsSheetName}`,
      action: "clear rows and rewrite the current Order Events header",
    },
    {
      target: `${config.googleSheetsStatsSheetName}`,
      action: "rebuild from the now-empty Google Sheets Trades tab",
    },
  ];
}

function printTargets(title: string, targets: ResetTarget[]): void {
  console.log(title);
  if (targets.length === 0) {
    console.log("  - none");
    return;
  }

  for (const target of targets) {
    console.log(`  - ${target.target}: ${target.action}`);
  }
}

function printHelp(): void {
  console.log("Full bot reset script");
  console.log("");
  console.log("Usage:");
  console.log("  npm run reset:all");
  console.log("  npm run reset:all:dry-run");
  console.log("  npm run reset:all:help");
  console.log("");
  console.log("What it resets:");
  console.log("  - Local trades.csv back to the current header row.");
  console.log("  - Local order-events.csv back to the current header row.");
  console.log("  - Local stats.csv rebuilt from the now-empty trades.csv.");
  console.log("  - Local bot-state.json risk counters, pending live order, and pending settlements.");
  console.log("  - Google Sheets Trades, Order Events, and Stats tabs when googleSheetsEnabled=true.");
  console.log("");
  console.log("What it preserves:");
  console.log("  - bot.config.json and .env.");
  console.log("  - Google Sheets Setup, Dashboard, Advanced Stats, and Analysis Data tabs when present.");
  console.log("  - Configured Google Sheets Candles tab when present.");
  console.log("  - Spreadsheet settings such as starting balance and expected winrate.");
  console.log("");
  console.log("Before running on the VPS:");
  console.log("  1. Stop the bot with: pm2 stop polymarket-bot");
  console.log("  2. Run dry-run first: npm run reset:all:dry-run");
  console.log("  3. Run reset: npm run reset:all");
  console.log("  4. Start the bot again with: pm2 start polymarket-bot");
}

function printPlan(config: ReturnType<typeof loadConfig>): void {
  printTargets("Local reset targets:", buildLocalTargets(config));
  console.log("");
  printTargets("Google Sheets reset targets:", buildSheetTargets(config));
  console.log("");
  console.log("Preserved settings and tabs:");
  console.log("  - bot.config.json");
  console.log("  - .env");
  if (config.googleSheetsEnabled) {
    const preservedNames = Array.from(new Set([...preservedSheetNames, config.googleSheetsCandlesSheetName]));
    for (const sheetName of preservedNames) {
      console.log(`  - ${sheetName}`);
    }
  }
}

async function resetGoogleSheets(config: ReturnType<typeof loadConfig>): Promise<void> {
  if (!config.googleSheetsEnabled) {
    console.log("[SHEETS_RESET_SKIPPED]");
    console.log("googleSheetsEnabled=false, no Google Sheets tabs were changed.");
    return;
  }

  const logger = new GoogleSheetsLogger(config);
  await logger.clearLogs();
  console.log("[SHEETS_RESET]");
  console.log("Google Sheets Trades, Order Events, and Stats tabs were reset.");
}

function resetLocalState(config: ReturnType<typeof loadConfig>): void {
  writeTextFile(config.logFile, `${tradeCsvHeader}\n`);
  writeTextFile(config.orderEventsFile, `${orderEventCsvHeader}\n`);
  refreshStatsLog(config.logFile, config.statsFile);
  new RuntimeStateStore(config).save(emptyRuntimeState());
  console.log("[LOCAL_RESET]");
  console.log("Local CSV logs, stats, and runtime state were reset.");
}

async function main(): Promise<void> {
  if (shouldPrintHelp()) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const dryRun = shouldDryRun();

  console.log("[FULL_RESET_START]");
  console.log(`execution mode in config: ${config.executionMode}`);
  console.log(`google sheets enabled: ${config.googleSheetsEnabled}`);
  console.log("");
  printPlan(config);

  if (dryRun) {
    console.log("");
    console.log("[FULL_RESET_DRY_RUN]");
    console.log("No files or spreadsheet tabs were changed.");
    return;
  }

  if (!isConfirmed()) {
    throw new Error("Refusing to reset without --confirm. Use npm run reset:all or pass --confirm explicitly.");
  }

  console.log("");
  await resetGoogleSheets(config);
  resetLocalState(config);
  console.log("");
  console.log("[FULL_RESET_DONE]");
  console.log("Bot logs and runtime state now start from zero. Settings were preserved.");
}

void main().catch((error) => {
  console.error("");
  console.error("[ERROR]");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
