import { fetchCandles } from "./candles";
import { loadConfig } from "./config";
import {
  appendTradeResult,
  ensureCsvLog,
  logError,
  logLiveCancel,
  logLiveDryRun,
  logLiveOrder,
  logResult,
  logSignal,
  logSkip,
  logStartup,
  logWarmup,
} from "./logger";
import { createPaperTrade, resolvePaperTrade } from "./paperBroker";
import { PolymarketLiveExecutor } from "./liveExecutor";
import { RuntimeRiskManager } from "./riskManager";
import { TradingViewReversalStrategy } from "./strategy";
import { Candle, LiveOrder, PaperTrade } from "./types";

const config = loadConfig();
const runOnce = process.env.RUN_ONCE === "1" || process.env.RUN_ONCE?.toLowerCase() === "true";
if (config.executionMode === "live" && runOnce) {
  throw new Error("RUN_ONCE is disabled in live mode because open orders need ongoing cancel/fill tracking");
}

const strategy = new TradingViewReversalStrategy(config);
const riskManager = new RuntimeRiskManager(config);
const polymarketExecutor = config.executionMode !== "paper" ? new PolymarketLiveExecutor(config) : null;
const liveExecutor = config.executionMode === "live" ? polymarketExecutor : null;

let initialized = false;
let lastProcessedClosedCandleOpenTime = 0;
let lastHandledCandleOpenTime = 0;
let lastEarlyEntryTargetOpenTime = 0;
let pendingTrade: PaperTrade | null = null;
let pendingLiveOrder: LiveOrder | null = null;
let shuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function secondsIntoCandle(candle: Candle, now: number): number {
  return Math.max(0, Math.floor((now - candle.openTime) / 1000));
}

function secondsUntilCandleClose(candle: Candle, now: number): number {
  return Math.max(0, Math.ceil((candle.closeTime - now) / 1000));
}

function getNextCandlePlaceholder(currentCandle: Candle): Candle {
  const intervalMs = currentCandle.closeTime - currentCandle.openTime + 1;
  const nextOpenTime = currentCandle.closeTime + 1;
  const price = currentCandle.close;

  return {
    openTime: nextOpenTime,
    closeTime: nextOpenTime + intervalMs - 1,
    open: price,
    high: price,
    low: price,
    close: price,
    color: "doji",
  };
}

function warmUpStrategy(closedCandles: Candle[]): void {
  if (initialized) {
    return;
  }

  strategy.warmUp(closedCandles);
  lastProcessedClosedCandleOpenTime = closedCandles[closedCandles.length - 1]?.openTime ?? 0;
  initialized = true;
  logWarmup(closedCandles.length);
}

async function cancelPendingLiveOrder(): Promise<void> {
  if (!liveExecutor || !pendingLiveOrder || pendingLiveOrder.canceled) {
    return;
  }

  try {
    pendingLiveOrder = await liveExecutor.cancelOrder(pendingLiveOrder);
    logLiveCancel(pendingLiveOrder);
  } catch (error) {
    logError(error);
  }
}

async function refreshPendingLiveOrderFillStatus(): Promise<void> {
  if (!liveExecutor || !pendingLiveOrder) {
    return;
  }

  try {
    pendingLiveOrder = await liveExecutor.refreshFillStatus(pendingLiveOrder);
  } catch (error) {
    logError(error);
  }
}

async function cancelPendingLiveOrderIfDue(now: number): Promise<void> {
  if (!liveExecutor || !pendingLiveOrder || pendingLiveOrder.canceled) {
    return;
  }

  try {
    const updatedOrder = await liveExecutor.cancelIfDue(pendingLiveOrder, now);
    if (!pendingLiveOrder.canceled && updatedOrder.canceled) {
      logLiveCancel(updatedOrder);
    }
    pendingLiveOrder = updatedOrder;
  } catch (error) {
    logError(error);
  }
}

async function openTrade(trade: PaperTrade, sourceCandleOpenTime: number): Promise<boolean> {
  logSignal(trade, config.tradeWindowSeconds);

  if (config.executionMode === "live_dry_run" && polymarketExecutor) {
    try {
      riskManager.assertCanOpen(trade);
      const dryRunOrder = await polymarketExecutor.dryRunLimitBuy(trade);
      logLiveDryRun(dryRunOrder);
      pendingTrade = trade;
      return true;
    } catch (error) {
      logError(error);
      logSkip(`${new Date(sourceCandleOpenTime).toISOString()} live dry-run preflight failed`);
      return false;
    }
  }

  if (liveExecutor) {
    try {
      riskManager.assertCanOpen(trade);
      pendingLiveOrder = await liveExecutor.placeLimitBuy(trade);
      pendingTrade = trade;
      riskManager.recordOrderPlaced(trade.signalTime);
      logLiveOrder(pendingLiveOrder);
      return true;
    } catch (error) {
      logError(error);
      logSkip(`${new Date(sourceCandleOpenTime).toISOString()} live order was not placed; signal will not update live retry state`);
      return false;
    }
  }

  pendingTrade = trade;
  return true;
}

async function maybeOpenEarlyEntry(currentCandle: Candle, now: number): Promise<void> {
  if (!config.earlyEntryEnabled || pendingTrade) {
    return;
  }

  if (now > currentCandle.closeTime) {
    return;
  }

  const nextCandle = getNextCandlePlaceholder(currentCandle);
  if (lastEarlyEntryTargetOpenTime === nextCandle.openTime) {
    return;
  }

  const secondsLeft = secondsUntilCandleClose(currentCandle, now);
  if (secondsLeft > config.earlyEntrySecondsBeforeClose) {
    return;
  }

  const decision = strategy.getEarlySignalForNextCandle(currentCandle);
  if (!decision.signal) {
    return;
  }

  const trade = createPaperTrade(config, decision.signal, nextCandle, now);
  const opened = await openTrade(trade, currentCandle.openTime);
  if (opened) {
    lastEarlyEntryTargetOpenTime = nextCandle.openTime;
  }
}

async function processNewClosedCandles(closedCandles: Candle[]): Promise<void> {
  const newClosedCandles = closedCandles.filter((candle) => candle.openTime > lastProcessedClosedCandleOpenTime);

  for (const candle of newClosedCandles) {
    if (pendingTrade && pendingTrade.candleOpenTime === candle.openTime) {
      await cancelPendingLiveOrder();
      await refreshPendingLiveOrderFillStatus();
      if (liveExecutor && pendingLiveOrder && !pendingLiveOrder.filled) {
        logSkip(`${new Date(candle.openTime).toISOString()} live order was not filled; candle will not update retry state`);
        strategy.processClosedCandleWithoutTrade(candle);
        pendingTrade = null;
        pendingLiveOrder = null;
        lastProcessedClosedCandleOpenTime = candle.openTime;
        continue;
      }

      const resolvedTrade = resolvePaperTrade(pendingTrade, candle);
      logResult(resolvedTrade);
      appendTradeResult(config.logFile, resolvedTrade);
      strategy.recordTradeResult(resolvedTrade, candle);
      riskManager.recordResolvedTrade(resolvedTrade);
      pendingTrade = null;
      pendingLiveOrder = null;
    } else {
      strategy.processClosedCandleWithoutTrade(candle);
    }

    lastProcessedClosedCandleOpenTime = candle.openTime;
  }
}

async function tick(): Promise<void> {
  const candles = await fetchCandles(config, config.candleLimit);
  if (candles.length < 4) {
    throw new Error(`Need at least 4 candles, received ${candles.length}`);
  }

  const currentCandle = candles[candles.length - 1];
  const closedCandles = candles.slice(0, -1);
  const now = Date.now();

  if (!initialized) {
    warmUpStrategy(closedCandles);
  } else {
    await processNewClosedCandles(closedCandles);
  }

  await cancelPendingLiveOrderIfDue(now);
  await maybeOpenEarlyEntry(currentCandle, now);

  if (currentCandle.openTime === lastHandledCandleOpenTime) {
    return;
  }

  const elapsedSeconds = secondsIntoCandle(currentCandle, now);
  if (elapsedSeconds > config.tradeWindowSeconds) {
    logSkip(
      `${new Date(currentCandle.openTime).toISOString()} window expired (${elapsedSeconds}s into candle; max ${config.tradeWindowSeconds}s)`
    );
    lastHandledCandleOpenTime = currentCandle.openTime;
    return;
  }

  if (pendingTrade) {
    logSkip(`${new Date(currentCandle.openTime).toISOString()} pending trade still open`);
    lastHandledCandleOpenTime = currentCandle.openTime;
    return;
  }

  const decision = strategy.getSignalForNextCandle();
  if (!decision.signal) {
    logSkip(`${new Date(currentCandle.openTime).toISOString()} ${decision.reason}`);
    lastHandledCandleOpenTime = currentCandle.openTime;
    return;
  }

  const trade = createPaperTrade(config, decision.signal, currentCandle, now);
  await openTrade(trade, currentCandle.openTime);

  lastHandledCandleOpenTime = currentCandle.openTime;
}

async function main(): Promise<void> {
  ensureCsvLog(config.logFile);
  logStartup(config);

  while (!shuttingDown) {
    try {
      await tick();
    } catch (error) {
      logError(error);
      if (runOnce) {
        process.exitCode = 1;
        return;
      }
    }

    if (runOnce) {
      return;
    }

    await sleep(config.pollMs);
  }

  await cancelPendingLiveOrder();
}

function requestShutdown(signal: string): void {
  shuttingDown = true;
  console.log("");
  console.log("[STOP]");
  console.log(`Received ${signal}. Stopping after current poll.`);
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

void main();
