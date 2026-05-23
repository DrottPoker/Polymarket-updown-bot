import { loadConfig } from "../config/appConfig";
import { GoogleSheetsLogger } from "../logging/googleSheetsLogger";

const helpFlags = new Set(["--help", "-h", "help"]);

function shouldPrintHelp(): boolean {
  return process.argv.slice(2).some((argument) => helpFlags.has(argument));
}

function printHelp(): void {
  console.log("Google Sheets clear script");
  console.log("");
  console.log("Usage:");
  console.log("  npm run sheets:clear");
  console.log("  npm run sheets:clear:help");
  console.log("");
  console.log("What it does:");
  console.log("  - Clears the configured Google Sheets Trades tab back to the header row.");
  console.log("  - Clears the configured Google Sheets Order Events tab back to the header row.");
  console.log("  - Rebuilds the configured Google Sheets Stats tab from the now-empty Trades tab.");
  console.log("  - Does not delete the spreadsheet itself.");
  console.log("  - Does not edit local trades.csv or stats.csv files.");
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

  console.log("[SHEETS_CLEAR_START]");
  console.log(`spreadsheet: ${config.googleSheetsSpreadsheetId}`);
  console.log(`trades sheet: ${config.googleSheetsTradesSheetName}`);
  console.log(`stats sheet: ${config.googleSheetsStatsSheetName}`);
  console.log(`order events sheet: ${config.googleSheetsOrderEventsSheetName}`);

  const logger = new GoogleSheetsLogger(config);
  await logger.clearLogs();

  console.log("");
  console.log("[SHEETS_CLEAR]");
  console.log("Google Sheets logs were cleared and stats were rebuilt.");
}

void main().catch((error) => {
  console.error("");
  console.error("[ERROR]");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
