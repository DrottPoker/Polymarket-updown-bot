import "dotenv/config";
import { ExecutionMode } from "./types";

export type AppConfig = {
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
  earlyEntrySecondsBeforeClose: number;
  earlyEntryMinMovePct: number;
};

function readString(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function readOptionalString(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number, got "${raw}"`);
  }

  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  throw new Error(`${name} must be a boolean, got "${raw}"`);
}

function readExecutionMode(): ExecutionMode {
  const mode = readString("EXECUTION_MODE", "paper").toLowerCase().replace(/-/g, "_");
  if (mode === "paper" || mode === "live_dry_run" || mode === "live") {
    return mode;
  }

  throw new Error(`EXECUTION_MODE must be "paper", "live_dry_run", or "live", got "${mode}"`);
}

export function loadConfig(): AppConfig {
  const config: AppConfig = {
    symbol: readString("SYMBOL", "ETHUSDT").toUpperCase(),
    interval: readString("INTERVAL", "5m"),
    entryCents: readNumber("ENTRY_CENTS", 51),
    tradeWindowSeconds: readNumber("TRADE_WINDOW_SECONDS", 30),
    stakeUsd: readNumber("STAKE_USD", 5),
    evStakeUsd: readNumber("EV_STAKE_USD", 100),
    pollMs: readNumber("POLL_MS", 1000),
    candleLimit: readNumber("CANDLE_LIMIT", 300),
    logFile: readString("LOG_FILE", "trades.csv"),
    statsFile: readString("STATS_FILE", "stats.csv"),
    binanceBaseUrl: readString("BINANCE_BASE_URL", "https://api.binance.com"),
    ignoreDojiInTrend: readBoolean("IGNORE_DOJI_IN_TREND", true),
    useLossRetryLogic: readBoolean("USE_LOSS_RETRY_LOGIC", true),
    retryWaitCandles: readNumber("RETRY_WAIT_CANDLES", 0),
    executionMode: readExecutionMode(),
    liveTradingEnabled: readBoolean("LIVE_TRADING_ENABLED", false),
    liveConfirmation: readString("LIVE_CONFIRMATION", ""),
    gammaBaseUrl: readString("GAMMA_BASE_URL", "https://gamma-api.polymarket.com"),
    clobHost: readString("CLOB_HOST", "https://clob.polymarket.com"),
    polygonRpcUrl: readString("POLYGON_RPC_URL", "https://polygon-rpc.com"),
    polymarketAssetSlug: readString("POLYMARKET_ASSET_SLUG", "eth").toLowerCase(),
    polymarketIntervalSlug: readString("POLYMARKET_INTERVAL_SLUG", "5m").toLowerCase(),
    polymarketChainId: readNumber("POLYMARKET_CHAIN_ID", 137),
    polymarketPrivateKey: readOptionalString("POLYMARKET_PRIVATE_KEY"),
    polymarketFunderAddress:
      readOptionalString("POLYMARKET_FUNDER_ADDRESS") || readOptionalString("DEPOSIT_WALLET_ADDRESS"),
    polymarketSignatureType: readNumber("POLYMARKET_SIGNATURE_TYPE", 3),
    clobApiKey: readOptionalString("CLOB_API_KEY"),
    clobSecret: readOptionalString("CLOB_SECRET"),
    clobPassphrase: readOptionalString("CLOB_PASS_PHRASE") || readOptionalString("CLOB_PASSPHRASE"),
    maxEntryCents: readNumber("MAX_ENTRY_CENTS", 51),
    maxStakeUsd: readNumber("MAX_STAKE_USD", 5),
    maxDailyLossUsd: readNumber("MAX_DAILY_LOSS_USD", 25),
    maxTradesPerDay: readNumber("MAX_TRADES_PER_DAY", 20),
    maxLiveTradeWindowSeconds: readNumber("MAX_LIVE_TRADE_WINDOW_SECONDS", 60),
    earlyEntryEnabled: readBoolean("EARLY_ENTRY_ENABLED", false),
    earlyEntrySecondsBeforeClose: readNumber("EARLY_ENTRY_SECONDS_BEFORE_CLOSE", 15),
    earlyEntryMinMovePct: readNumber("EARLY_ENTRY_MIN_MOVE_PCT", 0.05),
  };

  if (config.entryCents <= 0 || config.entryCents >= 100) {
    throw new Error("ENTRY_CENTS must be greater than 0 and less than 100");
  }

  if (config.tradeWindowSeconds < 0) {
    throw new Error("TRADE_WINDOW_SECONDS must be 0 or greater");
  }

  if (config.stakeUsd <= 0) {
    throw new Error("STAKE_USD must be greater than 0");
  }

  if (config.evStakeUsd <= 0) {
    throw new Error("EV_STAKE_USD must be greater than 0");
  }

  if (config.pollMs <= 0) {
    throw new Error("POLL_MS must be greater than 0");
  }

  if (!Number.isInteger(config.candleLimit) || config.candleLimit < 110 || config.candleLimit > 1000) {
    throw new Error("CANDLE_LIMIT must be an integer between 110 and 1000");
  }

  if (!Number.isInteger(config.retryWaitCandles) || config.retryWaitCandles < 0 || config.retryWaitCandles > 10) {
    throw new Error("RETRY_WAIT_CANDLES must be an integer between 0 and 10");
  }

  if (config.maxEntryCents <= 0 || config.maxEntryCents >= 100) {
    throw new Error("MAX_ENTRY_CENTS must be greater than 0 and less than 100");
  }

  if (config.entryCents > config.maxEntryCents) {
    throw new Error(`ENTRY_CENTS (${config.entryCents}) must not exceed MAX_ENTRY_CENTS (${config.maxEntryCents})`);
  }

  if (config.maxStakeUsd <= 0) {
    throw new Error("MAX_STAKE_USD must be greater than 0");
  }

  if (config.stakeUsd > config.maxStakeUsd) {
    throw new Error(`STAKE_USD (${config.stakeUsd}) must not exceed MAX_STAKE_USD (${config.maxStakeUsd})`);
  }

  if (config.maxDailyLossUsd <= 0) {
    throw new Error("MAX_DAILY_LOSS_USD must be greater than 0");
  }

  if (!Number.isInteger(config.maxTradesPerDay) || config.maxTradesPerDay <= 0) {
    throw new Error("MAX_TRADES_PER_DAY must be a positive integer");
  }

  if (config.maxLiveTradeWindowSeconds <= 0) {
    throw new Error("MAX_LIVE_TRADE_WINDOW_SECONDS must be greater than 0");
  }

  if (config.earlyEntrySecondsBeforeClose <= 0) {
    throw new Error("EARLY_ENTRY_SECONDS_BEFORE_CLOSE must be greater than 0");
  }

  if (config.earlyEntryMinMovePct <= 0) {
    throw new Error("EARLY_ENTRY_MIN_MOVE_PCT must be greater than 0");
  }

  if (![0, 1, 2, 3].includes(config.polymarketSignatureType)) {
    throw new Error("POLYMARKET_SIGNATURE_TYPE must be 0, 1, 2, or 3");
  }

  const hasAnyClobCred = Boolean(config.clobApiKey || config.clobSecret || config.clobPassphrase);
  const hasAllClobCreds = Boolean(config.clobApiKey && config.clobSecret && config.clobPassphrase);
  if (hasAnyClobCred && !hasAllClobCreds) {
    throw new Error("CLOB_API_KEY, CLOB_SECRET, and CLOB_PASS_PHRASE must all be set together");
  }

  if (config.executionMode === "live") {
    if (!config.liveTradingEnabled) {
      throw new Error("EXECUTION_MODE=live requires LIVE_TRADING_ENABLED=true");
    }

    if (config.liveConfirmation !== "PLACE_REAL_POLYMARKET_ORDERS") {
      throw new Error("EXECUTION_MODE=live requires LIVE_CONFIRMATION=PLACE_REAL_POLYMARKET_ORDERS");
    }

    if (!config.polymarketPrivateKey || !config.polymarketPrivateKey.startsWith("0x")) {
      throw new Error("EXECUTION_MODE=live requires POLYMARKET_PRIVATE_KEY as a 0x-prefixed private key");
    }

    if (!config.polymarketFunderAddress || !config.polymarketFunderAddress.startsWith("0x")) {
      throw new Error("EXECUTION_MODE=live requires POLYMARKET_FUNDER_ADDRESS or DEPOSIT_WALLET_ADDRESS");
    }

    if (!config.polygonRpcUrl.startsWith("http://") && !config.polygonRpcUrl.startsWith("https://")) {
      throw new Error("EXECUTION_MODE=live requires POLYGON_RPC_URL to be a valid http(s) URL");
    }

    if (config.tradeWindowSeconds > config.maxLiveTradeWindowSeconds) {
      throw new Error(
        `EXECUTION_MODE=live requires TRADE_WINDOW_SECONDS (${config.tradeWindowSeconds}) <= MAX_LIVE_TRADE_WINDOW_SECONDS (${config.maxLiveTradeWindowSeconds})`
      );
    }
  }

  return config;
}
