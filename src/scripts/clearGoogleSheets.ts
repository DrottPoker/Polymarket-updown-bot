import { loadConfig } from "../config/appConfig";
import { GoogleSheetsLogger } from "../logging/googleSheetsLogger";
import { orderEventCsvColumns, statsCsvColumns, tradeCsvColumns } from "../logging/logger";

const helpFlags = new Set(["--help", "-h", "help"]);
const dryRunFlags = new Set(["--dry-run", "--check", "check"]);
const preservedSheetNames = ["Setup", "Dashboard", "Advanced Stats", "Analysis Data"];

type ClearTarget = {
  sheetName: string;
  range: string;
  action: string;
};

function shouldPrintHelp(): boolean {
  return process.argv.slice(2).some((argument) => helpFlags.has(argument));
}

function shouldDryRun(): boolean {
  return process.argv.slice(2).some((argument) => dryRunFlags.has(argument));
}

function columnName(columnCount: number): string {
  let index = columnCount;
  let name = "";

  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }

  return name;
}

function buildClearTargets(config: ReturnType<typeof loadConfig>): ClearTarget[] {
  return [
    {
      sheetName: config.googleSheetsTradesSheetName,
      range: `A:${columnName(tradeCsvColumns.length)}`,
      action: "clear rows and rewrite the current Trades header",
    },
    {
      sheetName: config.googleSheetsOrderEventsSheetName,
      range: `A:${columnName(orderEventCsvColumns.length)}`,
      action: "clear rows and rewrite the current Order Events header",
    },
    {
      sheetName: config.googleSheetsStatsSheetName,
      range: `A:${columnName(statsCsvColumns.length)}`,
      action: "rebuild from the now-empty Trades tab",
    },
  ];
}

function buildPreservedSheetNames(clearTargets: ClearTarget[]): string[] {
  const targetNames = new Set(clearTargets.map((target) => target.sheetName));
  return preservedSheetNames.filter((sheetName) => !targetNames.has(sheetName));
}

function printClearPlan(config: ReturnType<typeof loadConfig>): void {
  const clearTargets = buildClearTargets(config);
  const preservedNames = buildPreservedSheetNames(clearTargets);

  console.log("Clear targets:");
  for (const target of clearTargets) {
    console.log(`  - ${target.sheetName}!${target.range}: ${target.action}`);
  }

  console.log("");
  console.log("Preserved tabs if present:");
  for (const sheetName of preservedNames) {
    console.log(`  - ${sheetName}`);
  }
}

function printHelp(): void {
  console.log("Google Sheets clear script");
  console.log("");
  console.log("Usage:");
  console.log("  npm run sheets:clear");
  console.log("  npm run sheets:clear:dry-run");
  console.log("  npm run sheets:clear:help");
  console.log("");
  console.log("What it does:");
  console.log("  - Clears the configured Google Sheets Trades tab back to the current header row.");
  console.log("  - Clears the configured Google Sheets Order Events tab back to the current header row.");
  console.log("  - Rebuilds the configured Google Sheets Stats tab from the now-empty Trades tab.");
  console.log("  - Preserves Setup, Dashboard, Advanced Stats, and Analysis Data when those tabs exist.");
  console.log("  - Keeps Setup inputs such as starting balance and expected winrate unchanged.");
  console.log("  - Does not delete the spreadsheet itself.");
  console.log("  - Does not edit local trades.csv or stats.csv files.");
  console.log("");
  console.log("Dry run:");
  console.log("  - Use npm run sheets:clear:dry-run to print the exact targets without changing the spreadsheet.");
  console.log("");
  console.log("Before running on the VPS:");
  console.log("  1. Stop the bot with: pm2 stop polymarket-bot");
  console.log("  2. Confirm bot.config.json has googleSheetsEnabled=true.");
  console.log("  3. Confirm GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY are set in .env.");
  console.log("");
  console.log("After clearing:");
  console.log("  1. Start the bot with: pm2 start polymarket-bot");
  console.log("  2. Watch logs with: pm2 logs polymarket-bot");
}

async function main(): Promise<void> {
  if (shouldPrintHelp()) {
    printHelp();
    return;
  }

  const config = loadConfig();
  if (!config.googleSheetsEnabled) {
    throw new Error("googleSheetsEnabled must be true before clearing Google Sheets logs");
  }

  const dryRun = shouldDryRun();

  console.log("[SHEETS_CLEAR_START]");
  console.log(`spreadsheet: ${config.googleSheetsSpreadsheetId}`);
  console.log(`trades sheet: ${config.googleSheetsTradesSheetName}`);
  console.log(`stats sheet: ${config.googleSheetsStatsSheetName}`);
  console.log(`order events sheet: ${config.googleSheetsOrderEventsSheetName}`);
  console.log("");
  printClearPlan(config);

  if (dryRun) {
    console.log("");
    console.log("[SHEETS_CLEAR_DRY_RUN]");
    console.log("No spreadsheet changes were made.");
    return;
  }

  const logger = new GoogleSheetsLogger(config);
  await logger.clearLogs();

  console.log("");
  console.log("[SHEETS_CLEAR]");
  console.log("Google Sheets logs were cleared, protected tabs were preserved, and stats were rebuilt.");
}

void main().catch((error) => {
  console.error("");
  console.error("[ERROR]");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
