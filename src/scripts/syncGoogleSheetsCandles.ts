import { loadConfig } from "../config/appConfig";
import { GoogleSheetsLogger } from "../logging/googleSheetsLogger";
import { fetchCandles } from "../marketData/candles";
import { closePolymarketChainlinkCandleSources } from "../marketData/polymarketChainlinkCandles";

const helpFlags = new Set(["--help", "-h", "help"]);

function shouldPrintHelp(): boolean {
  return process.argv.slice(2).some((argument) => helpFlags.has(argument));
}

function printHelp(): void {
  console.log("Google Sheets candle sync");
  console.log("");
  console.log("Usage:");
  console.log("  npm run sheets:candles:sync");
  console.log("  npm run sheets:candles:sync:help");
  console.log("");
  console.log("What it does:");
  console.log("  - Fetches the currently configured candle source.");
  console.log("  - Removes the currently forming candle.");
  console.log("  - Upserts closed candles into the configured Google Sheets Candles tab.");
  console.log("  - Does not edit Trades, Order Events, Stats, local CSV files, runtime state, or config.");
}

async function main(): Promise<void> {
  if (shouldPrintHelp()) {
    printHelp();
    return;
  }

  const config = loadConfig();
  if (!config.googleSheetsEnabled) {
    throw new Error("googleSheetsEnabled must be true before syncing Google Sheets candles");
  }

  const candles = await fetchCandles(config, config.candleLimit);
  const closedCandles = candles.slice(0, -1);
  const logger = new GoogleSheetsLogger(config);
  await logger.upsertCandles(closedCandles);

  console.log("[SHEETS_CANDLES_SYNC]");
  console.log(`spreadsheet: ${config.googleSheetsSpreadsheetId}`);
  console.log(`candles sheet: ${config.googleSheetsCandlesSheetName}`);
  console.log(`closed candles upserted: ${closedCandles.length}`);
}

void main()
  .catch((error) => {
    console.error("");
    console.error("[ERROR]");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    closePolymarketChainlinkCandleSources();
  });
