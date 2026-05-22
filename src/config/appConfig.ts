import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ExecutionMode, PriceSource } from "../domain/types";

type BotConfigFile = Partial<{
  priceSource: string;
  symbol: string;
  interval: string;
  entryCents: number;
  tradeWindowSeconds: number;
  stakeUsd: number;
  evStakeUsd: number;
  pollMs: number;
  candleLimit: number;
  logFile: string;
  statsFile: string;
  binanceBaseUrl: string;
  ignoreDojiInTrend: boolean;
  useLossRetryLogic: boolean;
  retryWaitCandles: number;
  executionMode: string;
  liveTradingEnabled: boolean;
  liveConfirmation: string;
  gammaBaseUrl: string;
  polymarketRtdsUrl: string;
  polymarketRtdsFirstPriceTimeoutMs: number;
  polymarketHistoryBatchSize: number;
  clobHost: string;
  polymarketAssetSlug: string;
  polymarketIntervalSlug: string;
  polymarketChainId: number;
  polymarketSignatureType: number;
  maxEntryCents: number;
  maxStakeUsd: number;
  maxDailyLossUsd: number;
  maxTradesPerDay: number;
  maxLiveTradeWindowSeconds: number;
  earlyEntryEnabled: boolean;
  earlyEntryPrimarySecondsBeforeClose: number;
  earlyEntryPrimaryMinMovePct: number;
  earlyEntrySecondarySecondsBeforeClose: number;
  earlyEntrySecondaryMinMovePct: number;
  earlyEntryOrderSecondsBeforeClose: number;
  noTradeWindowEnabled: boolean;
  noTradeStart: string;
  noTradeEnd: string;
  noTradeTimeZone: string;
  googleSheetsEnabled: boolean;
  googleSheetsSpreadsheetId: string;
  googleSheetsTradesSheetName: string;
  googleSheetsStatsSheetName: string;
}>;

type ConfigKey = keyof BotConfigFile;

export type AppConfig = {
  priceSource: PriceSource;
  symbol: string;
  interval: string;
  entryCents: number;
  tradeWindowSeconds: number;
  stakeUsd: number;
  evStakeUsd: number;
  pollMs: number;
  candleLimit: number;
  logFile: string;
  statsFile: string;
  binanceBaseUrl: string;
  ignoreDojiInTrend: boolean;
  useLossRetryLogic: boolean;
  retryWaitCandles: number;
  executionMode: ExecutionMode;
  liveTradingEnabled: boolean;
  liveConfirmation: string;
  gammaBaseUrl: string;
  polymarketRtdsUrl: string;
  polymarketRtdsFirstPriceTimeoutMs: number;
  polymarketHistoryBatchSize: number;
  clobHost: string;
  polygonRpcUrl: string;
  polymarketAssetSlug: string;
  polymarketIntervalSlug: string;
  polymarketChainId: number;
  polymarketPrivateKey: string;
  polymarketFunderAddress: string;
  polymarketSignatureType: number;
  clobApiKey: string;
  clobSecret: string;
  clobPassphrase: string;
  maxEntryCents: number;
  maxStakeUsd: number;
  maxDailyLossUsd: number;
  maxTradesPerDay: number;
  maxLiveTradeWindowSeconds: number;
  earlyEntryEnabled: boolean;
  earlyEntryPrimarySecondsBeforeClose: number;
  earlyEntryPrimaryMinMovePct: number;
  earlyEntrySecondarySecondsBeforeClose: number;
  earlyEntrySecondaryMinMovePct: number;
  earlyEntryOrderSecondsBeforeClose: number;
  noTradeWindowEnabled: boolean;
  noTradeStart: string;
  noTradeEnd: string;
  noTradeTimeZone: string;
  googleSheetsEnabled: boolean;
  googleSheetsSpreadsheetId: string;
  googleSheetsTradesSheetName: string;
  googleSheetsStatsSheetName: string;
  googleServiceAccountEmail: string;
  googlePrivateKey: string;
};

function loadBotConfigFile(): BotConfigFile {
  const configPath = process.env.BOT_CONFIG_FILE?.trim() || "bot.config.json";
  const absolutePath = resolve(configPath);
  if (!existsSync(absolutePath)) {
    return {};
  }

  const parsed: unknown = JSON.parse(readFileSync(absolutePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object`);
  }

  return parsed as BotConfigFile;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === "string" && value.trim().length === 0);
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readValue<T>(configFile: BotConfigFile, key: ConfigKey, fallback: T): T {
  const value = configFile[key];
  return hasValue(value) ? (value as T) : fallback;
}

function readString(configFile: BotConfigFile, key: ConfigKey, fallback: string): string {
  return String(readValue(configFile, key, fallback)).trim();
}

function readNumber(configFile: BotConfigFile, key: ConfigKey, fallback: number): number {
  const raw = readValue(configFile, key, fallback);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number, got "${String(raw)}"`);
  }

  return value;
}

function readBoolean(configFile: BotConfigFile, key: ConfigKey, fallback: boolean): boolean {
  const raw = readValue(configFile, key, fallback);
  if (typeof raw === "boolean") {
    return raw;
  }

  throw new Error(`${key} must be a boolean, got "${String(raw)}"`);
}

function readSecretString(name: string, fallback = ""): string {
  return envValue(name) ?? fallback;
}

function readGooglePrivateKey(): string {
  return readSecretString("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n");
}

function readExecutionMode(configFile: BotConfigFile): ExecutionMode {
  const mode = (envValue("BOT_EXECUTION_MODE") ?? readString(configFile, "executionMode", "paper"))
    .toLowerCase()
    .replace(/-/g, "_");
  if (mode === "paper" || mode === "live_dry_run" || mode === "live") {
    return mode;
  }

  throw new Error(`executionMode must be "paper", "live_dry_run", or "live", got "${mode}"`);
}

function readPriceSource(configFile: BotConfigFile): PriceSource {
  const source = readString(configFile, "priceSource", "polymarket_chainlink").toLowerCase().replace(/-/g, "_");
  if (source === "binance" || source === "polymarket_chainlink") {
    return source;
  }

  throw new Error(`priceSource must be "binance" or "polymarket_chainlink", got "${source}"`);
}

function readClockTime(configFile: BotConfigFile, key: ConfigKey, fallback: string): string {
  const value = readString(configFile, key, fallback).replace(/\./g, ":");
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    throw new Error(`${key} must use HH:mm 24-hour format, got "${value}"`);
  }

  return value;
}

function clockTimeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function readTimeZone(configFile: BotConfigFile, key: ConfigKey, fallback: string): string {
  const value = readString(configFile, key, fallback);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
  } catch {
    throw new Error(`${key} must be a valid IANA time zone, got "${value}"`);
  }

  return value;
}

export function loadConfig(): AppConfig {
  const configFile = loadBotConfigFile();
  const config: AppConfig = {
    priceSource: readPriceSource(configFile),
    symbol: readString(configFile, "symbol", "ETHUSDT").toUpperCase(),
    interval: readString(configFile, "interval", "5m"),
    entryCents: readNumber(configFile, "entryCents", 51),
    tradeWindowSeconds: readNumber(configFile, "tradeWindowSeconds", 30),
    stakeUsd: readNumber(configFile, "stakeUsd", 5),
    evStakeUsd: readNumber(configFile, "evStakeUsd", 100),
    pollMs: readNumber(configFile, "pollMs", 1000),
    candleLimit: readNumber(configFile, "candleLimit", 300),
    logFile: readString(configFile, "logFile", "trades.csv"),
    statsFile: readString(configFile, "statsFile", "stats.csv"),
    binanceBaseUrl: readString(configFile, "binanceBaseUrl", "https://api.binance.com"),
    ignoreDojiInTrend: readBoolean(configFile, "ignoreDojiInTrend", true),
    useLossRetryLogic: readBoolean(configFile, "useLossRetryLogic", true),
    retryWaitCandles: readNumber(configFile, "retryWaitCandles", 0),
    executionMode: readExecutionMode(configFile),
    liveTradingEnabled: readBoolean(configFile, "liveTradingEnabled", false),
    liveConfirmation: readString(configFile, "liveConfirmation", ""),
    gammaBaseUrl: readString(configFile, "gammaBaseUrl", "https://gamma-api.polymarket.com"),
    polymarketRtdsUrl: readString(configFile, "polymarketRtdsUrl", "wss://ws-live-data.polymarket.com"),
    polymarketRtdsFirstPriceTimeoutMs: readNumber(configFile, "polymarketRtdsFirstPriceTimeoutMs", 15_000),
    polymarketHistoryBatchSize: readNumber(configFile, "polymarketHistoryBatchSize", 75),
    clobHost: readString(configFile, "clobHost", "https://clob.polymarket.com"),
    polygonRpcUrl: readSecretString("POLYGON_RPC_URL", "https://polygon-rpc.com"),
    polymarketAssetSlug: readString(configFile, "polymarketAssetSlug", "eth").toLowerCase(),
    polymarketIntervalSlug: readString(configFile, "polymarketIntervalSlug", "5m").toLowerCase(),
    polymarketChainId: readNumber(configFile, "polymarketChainId", 137),
    polymarketPrivateKey: readSecretString("POLYMARKET_PRIVATE_KEY"),
    polymarketFunderAddress: readSecretString("POLYMARKET_FUNDER_ADDRESS"),
    polymarketSignatureType: readNumber(configFile, "polymarketSignatureType", 3),
    clobApiKey: readSecretString("CLOB_API_KEY"),
    clobSecret: readSecretString("CLOB_SECRET"),
    clobPassphrase: readSecretString("CLOB_PASS_PHRASE"),
    maxEntryCents: readNumber(configFile, "maxEntryCents", 51),
    maxStakeUsd: readNumber(configFile, "maxStakeUsd", 5),
    maxDailyLossUsd: readNumber(configFile, "maxDailyLossUsd", 25),
    maxTradesPerDay: readNumber(configFile, "maxTradesPerDay", 20),
    maxLiveTradeWindowSeconds: readNumber(configFile, "maxLiveTradeWindowSeconds", 60),
    earlyEntryEnabled: readBoolean(configFile, "earlyEntryEnabled", false),
    earlyEntryPrimarySecondsBeforeClose: readNumber(configFile, "earlyEntryPrimarySecondsBeforeClose", 15),
    earlyEntryPrimaryMinMovePct: readNumber(configFile, "earlyEntryPrimaryMinMovePct", 0.05),
    earlyEntrySecondarySecondsBeforeClose: readNumber(configFile, "earlyEntrySecondarySecondsBeforeClose", 5),
    earlyEntrySecondaryMinMovePct: readNumber(configFile, "earlyEntrySecondaryMinMovePct", 0.02),
    earlyEntryOrderSecondsBeforeClose: readNumber(configFile, "earlyEntryOrderSecondsBeforeClose", 1),
    noTradeWindowEnabled: readBoolean(configFile, "noTradeWindowEnabled", false),
    noTradeStart: readClockTime(configFile, "noTradeStart", "23:00"),
    noTradeEnd: readClockTime(configFile, "noTradeEnd", "07:00"),
    noTradeTimeZone: readTimeZone(configFile, "noTradeTimeZone", "Europe/Stockholm"),
    googleSheetsEnabled: readBoolean(configFile, "googleSheetsEnabled", false),
    googleSheetsSpreadsheetId: readString(configFile, "googleSheetsSpreadsheetId", ""),
    googleSheetsTradesSheetName: readString(configFile, "googleSheetsTradesSheetName", "Trades"),
    googleSheetsStatsSheetName: readString(configFile, "googleSheetsStatsSheetName", "Stats"),
    googleServiceAccountEmail: readSecretString("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
    googlePrivateKey: readGooglePrivateKey(),
  };

  validateConfig(config);
  return config;
}

function validateConfig(config: AppConfig): void {
  if (config.entryCents <= 0 || config.entryCents >= 100) {
    throw new Error("entryCents must be greater than 0 and less than 100");
  }

  if (config.tradeWindowSeconds < 0) {
    throw new Error("tradeWindowSeconds must be 0 or greater");
  }

  if (config.stakeUsd <= 0) {
    throw new Error("stakeUsd must be greater than 0");
  }

  if (config.evStakeUsd <= 0) {
    throw new Error("evStakeUsd must be greater than 0");
  }

  if (config.pollMs <= 0) {
    throw new Error("pollMs must be greater than 0");
  }

  if (!Number.isInteger(config.candleLimit) || config.candleLimit < 110 || config.candleLimit > 1000) {
    throw new Error("candleLimit must be an integer between 110 and 1000");
  }

  if (!Number.isInteger(config.retryWaitCandles) || config.retryWaitCandles < 0 || config.retryWaitCandles > 10) {
    throw new Error("retryWaitCandles must be an integer between 0 and 10");
  }

  if (config.maxEntryCents <= 0 || config.maxEntryCents >= 100) {
    throw new Error("maxEntryCents must be greater than 0 and less than 100");
  }

  if (config.entryCents > config.maxEntryCents) {
    throw new Error(`entryCents (${config.entryCents}) must not exceed maxEntryCents (${config.maxEntryCents})`);
  }

  if (config.maxStakeUsd <= 0) {
    throw new Error("maxStakeUsd must be greater than 0");
  }

  if (config.stakeUsd > config.maxStakeUsd) {
    throw new Error(`stakeUsd (${config.stakeUsd}) must not exceed maxStakeUsd (${config.maxStakeUsd})`);
  }

  if (config.maxDailyLossUsd <= 0) {
    throw new Error("maxDailyLossUsd must be greater than 0");
  }

  if (!Number.isInteger(config.maxTradesPerDay) || config.maxTradesPerDay <= 0) {
    throw new Error("maxTradesPerDay must be a positive integer");
  }

  if (config.maxLiveTradeWindowSeconds <= 0) {
    throw new Error("maxLiveTradeWindowSeconds must be greater than 0");
  }

  if (config.earlyEntryPrimarySecondsBeforeClose <= 0) {
    throw new Error("earlyEntryPrimarySecondsBeforeClose must be greater than 0");
  }

  if (config.earlyEntrySecondarySecondsBeforeClose <= 0) {
    throw new Error("earlyEntrySecondarySecondsBeforeClose must be greater than 0");
  }

  if (config.earlyEntryOrderSecondsBeforeClose <= 0) {
    throw new Error("earlyEntryOrderSecondsBeforeClose must be greater than 0");
  }

  if (config.earlyEntryPrimaryMinMovePct <= 0) {
    throw new Error("earlyEntryPrimaryMinMovePct must be greater than 0");
  }

  if (config.earlyEntrySecondaryMinMovePct <= 0) {
    throw new Error("earlyEntrySecondaryMinMovePct must be greater than 0");
  }

  if (config.earlyEntryPrimarySecondsBeforeClose <= config.earlyEntrySecondarySecondsBeforeClose) {
    throw new Error("earlyEntryPrimarySecondsBeforeClose must be greater than earlyEntrySecondarySecondsBeforeClose");
  }

  if (config.earlyEntrySecondarySecondsBeforeClose <= config.earlyEntryOrderSecondsBeforeClose) {
    throw new Error("earlyEntrySecondarySecondsBeforeClose must be greater than earlyEntryOrderSecondsBeforeClose");
  }

  if (
    !Number.isInteger(config.polymarketHistoryBatchSize) ||
    config.polymarketHistoryBatchSize < 1 ||
    config.polymarketHistoryBatchSize > 100
  ) {
    throw new Error("polymarketHistoryBatchSize must be an integer between 1 and 100");
  }

  if (config.polymarketRtdsFirstPriceTimeoutMs <= 0) {
    throw new Error("polymarketRtdsFirstPriceTimeoutMs must be greater than 0");
  }

  if (
    config.priceSource === "polymarket_chainlink" &&
    !config.polymarketRtdsUrl.startsWith("ws://") &&
    !config.polymarketRtdsUrl.startsWith("wss://")
  ) {
    throw new Error("polymarketRtdsUrl must be a valid ws(s) URL");
  }

  if (clockTimeToMinutes(config.noTradeStart) === clockTimeToMinutes(config.noTradeEnd)) {
    throw new Error("noTradeStart and noTradeEnd must not be the same time");
  }

  if (![0, 1, 2, 3].includes(config.polymarketSignatureType)) {
    throw new Error("polymarketSignatureType must be 0, 1, 2, or 3");
  }

  const hasAnyClobCred = Boolean(config.clobApiKey || config.clobSecret || config.clobPassphrase);
  const hasAllClobCreds = Boolean(config.clobApiKey && config.clobSecret && config.clobPassphrase);
  if (hasAnyClobCred && !hasAllClobCreds) {
    throw new Error("CLOB_API_KEY, CLOB_SECRET, and CLOB_PASS_PHRASE must all be set together");
  }

  if (config.googleSheetsEnabled) {
    validateGoogleSheetsConfig(config);
  }

  if (config.executionMode === "live") {
    validateLiveConfig(config);
  }
}

function validateGoogleSheetsConfig(config: AppConfig): void {
  if (!config.googleSheetsSpreadsheetId) {
    throw new Error("googleSheetsEnabled=true requires googleSheetsSpreadsheetId");
  }

  if (!config.googleSheetsTradesSheetName) {
    throw new Error("googleSheetsTradesSheetName must not be empty");
  }

  if (!config.googleSheetsStatsSheetName) {
    throw new Error("googleSheetsStatsSheetName must not be empty");
  }

  if (config.googleSheetsTradesSheetName === config.googleSheetsStatsSheetName) {
    throw new Error("googleSheetsTradesSheetName and googleSheetsStatsSheetName must be different");
  }

  if (!config.googleServiceAccountEmail.includes("@")) {
    throw new Error("googleSheetsEnabled=true requires GOOGLE_SERVICE_ACCOUNT_EMAIL");
  }

  if (!config.googlePrivateKey.includes("BEGIN PRIVATE KEY")) {
    throw new Error("googleSheetsEnabled=true requires GOOGLE_PRIVATE_KEY");
  }
}

function validateLiveConfig(config: AppConfig): void {
  if (!config.liveTradingEnabled) {
    throw new Error("executionMode=live requires liveTradingEnabled=true");
  }

  if (config.liveConfirmation !== "PLACE_REAL_POLYMARKET_ORDERS") {
    throw new Error('executionMode=live requires liveConfirmation="PLACE_REAL_POLYMARKET_ORDERS"');
  }

  if (!config.polymarketPrivateKey || !config.polymarketPrivateKey.startsWith("0x")) {
    throw new Error("executionMode=live requires POLYMARKET_PRIVATE_KEY as a 0x-prefixed private key");
  }

  if (!config.polymarketFunderAddress || !config.polymarketFunderAddress.startsWith("0x")) {
    throw new Error("executionMode=live requires POLYMARKET_FUNDER_ADDRESS");
  }

  if (!config.polygonRpcUrl.startsWith("http://") && !config.polygonRpcUrl.startsWith("https://")) {
    throw new Error("executionMode=live requires POLYGON_RPC_URL to be a valid http(s) URL");
  }

  if (config.tradeWindowSeconds > config.maxLiveTradeWindowSeconds) {
    throw new Error(
      `executionMode=live requires tradeWindowSeconds (${config.tradeWindowSeconds}) <= maxLiveTradeWindowSeconds (${config.maxLiveTradeWindowSeconds})`
    );
  }
}
