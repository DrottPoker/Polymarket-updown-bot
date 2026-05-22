import { loadConfig } from "../config/appConfig";
import { GoogleSheetsLogger } from "../logging/googleSheetsLogger";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.googleSheetsEnabled) {
    throw new Error("googleSheetsEnabled must be true before clearing Google Sheets logs");
  }

  const logger = new GoogleSheetsLogger(config);
  await logger.clearLogs();
  console.log("[SHEETS_CLEAR]");
  console.log(`spreadsheet: ${config.googleSheetsSpreadsheetId}`);
  console.log(`trades sheet: ${config.googleSheetsTradesSheetName}`);
  console.log(`stats sheet: ${config.googleSheetsStatsSheetName}`);
}

void main().catch((error) => {
  console.error("");
  console.error("[ERROR]");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
