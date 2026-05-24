import { loadConfig } from "./config/appConfig";
import { Candle, LiveOrder, OrderEventType, PaperTrade, ResolvedPaperTrade } from "./domain/types";
import {
  appendTradeResult,
  ensureCsvLog,
  logError,
  logLiveCancel,
  logLiveDryRun,
  logLiveFill,
  logLiveOrder,
  logResult,
  logSignal,
  logSkip,
  logStartup,
  logWarmup,
  refreshStatsLog,
} from "./logging/logger";
import { GoogleSheetsLogger } from "./logging/googleSheetsLogger";
import { fetchCandles } from "./marketData/candles";
import { closePolymarketChainlinkCandleSources } from "./marketData/polymarketChainlinkCandles";
import { PolymarketLiveExecutor } from "./polymarket/liveExecutor";
import { createPaperTrade, resizeTradeToLiveFill, resolvePaperTrade } from "./trading/paperBroker";
import { RuntimeRiskManager } from "./trading/riskManager";
import { TradingViewReversalStrategy } from "./trading/strategy";

const config = loadConfig();
const runOnce = process.env.RUN_ONCE === "1" || process.env.RUN_ONCE?.toLowerCase() === "true";
if (config.executionMode === "live" && runOnce) {
  throw new Error("RUN_ONCE is disabled in live mode because open orders need ongoing cancel/fill tracking");
}

const strategy = new TradingViewReversalStrategy(config);
const riskManager = new RuntimeRiskManager(config);
const polymarketExecutor = config.executionMode !== "paper" ? new PolymarketLiveExecutor(config) : null;
const liveExecutor = config.executionMode === "live" ? polymarketExecutor : null;
const googleSheetsLogger = config.googleSheetsEnabled ? new GoogleSheetsLogger(config) : null;

let initialized = false;
let lastProcessedClosedCandleOpenTime = 0;
let lastHandledCandleOpenTime = 0;
let earlyEntryAttemptTargetOpenTime = 0;
let earlyEntryAttemptedStages = new Set<string>();
let pendingEarlyEntryTargetOpenTime: number | null = null;
let pendingEarlyEntryFinalValidationDone = false;
let pendingTrade: PaperTrade | null = null;
let pendingStrategyOnlyTrade: PaperTrade | null = null;
let pendingLiveOrder: LiveOrder | null = null;
let startupSkippedCandleOpenTime: number | null = null;
let lastInsufficientCandlesLogTime = 0;
let lastOfficialClosedCandleWaitLogTime = 0;
let shuttingDown = false;

type EarlyEntryStage = {
  name: string;
  label: string;
  secondsBeforeClose: number;
  minMovePct: number | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function secondsIntoCandle(candle: Candle, now: number): number {
  return Math.max(0, Math.floor((now - candle.openTime) / 1000));
}

function secondsUntilCandleClose(candle: Candle, now: number): number {
  return Math.max(0, Math.ceil((candle.closeTime - now) / 1000));
}

function getEarlyEntryStages(): EarlyEntryStage[] {
  return [
    {
      name: "primary",
      label: "primary early entry",
      secondsBeforeClose: config.earlyEntryPrimarySecondsBeforeClose,
      minMovePct: config.earlyEntryPrimaryMinMovePct,
    },
    {
      name: "secondary",
      label: "secondary early entry",
      secondsBeforeClose: config.earlyEntrySecondarySecondsBeforeClose,
      minMovePct: config.earlyEntrySecondaryMinMovePct,
    },
    {
      name: "final",
      label: "final early entry",
      secondsBeforeClose: config.earlyEntryOrderSecondsBeforeClose,
      minMovePct: null,
    },
  ];
}

function resetEarlyEntryAttemptsForTarget(targetOpenTime: number): void {
  if (earlyEntryAttemptTargetOpenTime === targetOpenTime) {
    return;
  }

  earlyEntryAttemptTargetOpenTime = targetOpenTime;
  earlyEntryAttemptedStages = new Set<string>();
}

function markEarlyEntryTargetDone(targetOpenTime: number): void {
  resetEarlyEntryAttemptsForTarget(targetOpenTime);
  for (const stage of getEarlyEntryStages()) {
    earlyEntryAttemptedStages.add(stage.name);
  }
}

function trackPendingEarlyEntry(targetOpenTime: number, finalValidationDone: boolean): void {
  pendingEarlyEntryTargetOpenTime = targetOpenTime;
  pendingEarlyEntryFinalValidationDone = finalValidationDone;
}

function clearPendingEarlyEntryTracking(): void {
  pendingEarlyEntryTargetOpenTime = null;
  pendingEarlyEntryFinalValidationDone = false;
}

function formatCandleForLog(candle: Candle): string {
  return `${candle.color} open=${candle.open.toFixed(2)} close=${candle.close.toFixed(2)}`;
}

function logInsufficientCandles(candleCount: number, now: number): void {
  if (now - lastInsufficientCandlesLogTime < 30_000) {
    return;
  }

  lastInsufficientCandlesLogTime = now;
  logSkip(`Waiting for at least 4 Polymarket candles; received ${candleCount}`);
}

function logWaitingForOfficialClosedCandle(openTime: number, now: number): void {
  if (now - lastOfficialClosedCandleWaitLogTime < 30_000) {
    return;
  }

  lastOfficialClosedCandleWaitLogTime = now;
  logSkip(`${new Date(openTime).toISOString()} waiting for official Polymarket closed candle`);
}

function liveFillProgress(order: LiveOrder | null): string {
  if (!order || !order.filledSize || order.filledSize <= 0) {
    return "";
  }

  return `; matched ${order.filledSize.toFixed(4)} of ${order.size.toFixed(4)} shares`;
}

function liveFilledSize(order: LiveOrder | null): number {
  if (!order || !order.filledSize || order.filledSize <= 0) {
    return 0;
  }

  const filledSize = Math.min(order.filledSize, order.size);
  return order.size - filledSize <= config.liveFullFillToleranceShares ? order.size : filledSize;
}

function hasPartialLiveFill(order: LiveOrder | null): order is LiveOrder {
  return Boolean(order && !order.filled && liveFilledSize(order) > 0);
}

function liveOrderForFilledPortion(order: LiveOrder): LiveOrder {
  const filledSize = liveFilledSize(order);
  return {
    ...order,
    size: filledSize,
    filledSize,
    filled: true,
    status: order.filled ? order.status : "partial",
  };
}

function clockTimeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function localClockMinutes(timestampMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestampMs));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");

  return hour * 60 + minute;
}

function isNoTradeWindowActive(targetCandleOpenTime: number): boolean {
  if (!config.noTradeWindowEnabled) {
    return false;
  }

  const start = clockTimeToMinutes(config.noTradeStart);
  const end = clockTimeToMinutes(config.noTradeEnd);
  const target = localClockMinutes(targetCandleOpenTime, config.noTradeTimeZone);

  if (start < end) {
    return target >= start && target < end;
  }

  return target >= start || target < end;
}

function noTradeWindowLabel(): string {
  return `${config.noTradeStart}-${config.noTradeEnd} ${config.noTradeTimeZone}`;
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

function skipStartupCandle(currentCandle: Candle): void {
  startupSkippedCandleOpenTime = currentCandle.openTime;
  lastHandledCandleOpenTime = currentCandle.openTime;
  markEarlyEntryTargetDone(getNextCandlePlaceholder(currentCandle).openTime);
  logSkip(`${new Date(currentCandle.openTime).toISOString()} startup candle is already in progress; waiting for next signal`);
}

function logStartupSkippedCandleClosed(candle: Candle): void {
  if (startupSkippedCandleOpenTime !== candle.openTime) {
    return;
  }

  logSkip(
    `${new Date(candle.openTime).toISOString()} startup skipped candle closed as ${formatCandleForLog(candle)}; added to trend state only`
  );
  startupSkippedCandleOpenTime = null;
}

function trackStrategyOnlyTrade(trade: PaperTrade): void {
  pendingStrategyOnlyTrade = trade;
  logSkip(
    `${new Date(trade.candleOpenTime).toISOString()} ${trade.kind} ${trade.direction} signal skipped by no-trade window (${noTradeWindowLabel()}); strategy state will update without placing an order`
  );
}

async function cancelPendingLiveOrder(): Promise<void> {
  if (!liveExecutor || !pendingLiveOrder || pendingLiveOrder.canceled) {
    return;
  }

  try {
    const wasFilled = pendingLiveOrder.filled;
    const updatedOrder = await liveExecutor.cancelOrder(pendingLiveOrder);
    if (!wasFilled && updatedOrder.filled) {
      logLiveFill(updatedOrder);
    }
    if (!pendingLiveOrder.canceled && updatedOrder.canceled) {
      logLiveCancel(updatedOrder);
    }
    pendingLiveOrder = updatedOrder;
  } catch (error) {
    logError(error);
  }
}

async function syncGoogleSheetsOrderEvent(
  eventType: OrderEventType,
  trade: PaperTrade,
  liveOrder?: LiveOrder | null,
  detail?: string
): Promise<void> {
  if (!googleSheetsLogger) {
    return;
  }

  try {
    await googleSheetsLogger.appendOrderEvent({
      eventTime: Date.now(),
      eventType,
      trade,
      liveOrder,
      detail,
    });
  } catch (error) {
    logError(error);
  }
}

async function refreshPendingLiveOrderFillStatus(): Promise<void> {
  if (!liveExecutor || !pendingLiveOrder) {
    return;
  }

  try {
    const wasFilled = pendingLiveOrder.filled;
    pendingLiveOrder = await liveExecutor.refreshFillStatus(pendingLiveOrder);
    if (!wasFilled && pendingLiveOrder.filled) {
      logLiveFill(pendingLiveOrder);
    }
  } catch (error) {
    logError(error);
  }
}

async function cancelPendingLiveOrderIfDue(now: number): Promise<void> {
  if (!liveExecutor || !pendingLiveOrder || pendingLiveOrder.canceled) {
    return;
  }

  try {
    const wasFilled = pendingLiveOrder.filled;
    const updatedOrder = await liveExecutor.cancelIfDue(pendingLiveOrder, now);
    if (!wasFilled && updatedOrder.filled) {
      logLiveFill(updatedOrder);
    }
    if (!pendingLiveOrder.canceled && updatedOrder.canceled) {
      logLiveCancel(updatedOrder);
    }
    pendingLiveOrder = updatedOrder;
  } catch (error) {
    logError(error);
  }
}

async function cancelInvalidatedPendingEarlyEntry(currentCandle: Candle, reason: string): Promise<void> {
  if (!pendingTrade) {
    clearPendingEarlyEntryTracking();
    return;
  }

  logSkip(
    `${new Date(currentCandle.openTime).toISOString()} final early-entry validation failed (${reason}); canceling pending ${pendingTrade.kind} ${pendingTrade.direction} order`
  );

  if (!liveExecutor || !pendingLiveOrder) {
    pendingTrade = null;
    clearPendingEarlyEntryTracking();
    return;
  }

  await refreshPendingLiveOrderFillStatus();
  if (pendingLiveOrder.filled) {
    logSkip(
      `${new Date(currentCandle.openTime).toISOString()} final early-entry validation failed, but live order is already filled; trade will be managed to candle close`
    );
    pendingEarlyEntryFinalValidationDone = true;
    return;
  }

  await cancelPendingLiveOrder();
  if (pendingLiveOrder?.filled) {
    logSkip(
      `${new Date(currentCandle.openTime).toISOString()} final early-entry validation failed, but live order filled before cancel completed; trade will be managed to candle close`
    );
    pendingEarlyEntryFinalValidationDone = true;
    return;
  }

  if (pendingLiveOrder?.canceled) {
    await syncGoogleSheetsOrderEvent("FINAL_CHECK_CANCELED", pendingTrade, pendingLiveOrder, reason);
    pendingTrade = null;
    pendingLiveOrder = null;
    clearPendingEarlyEntryTracking();
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
      await syncGoogleSheetsOrderEvent("ORDER_PLACED", trade, pendingLiveOrder);
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

async function initializeGoogleSheets(): Promise<void> {
  if (!googleSheetsLogger) {
    return;
  }

  try {
    await googleSheetsLogger.ensureSheets();
    await googleSheetsLogger.refreshStats();
  } catch (error) {
    logError(error);
  }
}

async function syncGoogleSheetsTrade(trade: ResolvedPaperTrade, liveOrder?: LiveOrder | null): Promise<void> {
  if (!googleSheetsLogger) {
    return;
  }

  try {
    await googleSheetsLogger.appendTradeResult(trade, liveOrder);
    await googleSheetsLogger.refreshStats();
  } catch (error) {
    logError(error);
  }
}

function initializeLocalCsvLogs(): void {
  if (!config.localCsvLoggingEnabled) {
    return;
  }

  ensureCsvLog(config.logFile);
  refreshStatsLog(config.logFile, config.statsFile);
}

function writeLocalTradeLogs(trade: ResolvedPaperTrade, liveOrder?: LiveOrder | null): void {
  if (!config.localCsvLoggingEnabled) {
    return;
  }

  appendTradeResult(config.logFile, trade, liveOrder);
  refreshStatsLog(config.logFile, config.statsFile);
}

async function maybeOpenEarlyEntry(currentCandle: Candle, now: number): Promise<void> {
  if (!config.earlyEntryEnabled || pendingTrade || pendingStrategyOnlyTrade) {
    return;
  }

  if (now > currentCandle.closeTime) {
    return;
  }

  const nextCandle = getNextCandlePlaceholder(currentCandle);
  resetEarlyEntryAttemptsForTarget(nextCandle.openTime);

  const secondsLeft = secondsUntilCandleClose(currentCandle, now);
  const stage = getEarlyEntryStages().find(
    (earlyEntryStage) =>
      secondsLeft <= earlyEntryStage.secondsBeforeClose && !earlyEntryAttemptedStages.has(earlyEntryStage.name)
  );
  if (!stage) {
    return;
  }

  earlyEntryAttemptedStages.add(stage.name);

  const decision = strategy.getEarlySignalForNextCandle(currentCandle, {
    label: stage.label,
    minMovePct: stage.minMovePct,
  });
  if (!decision.signal) {
    return;
  }

  const trade = createPaperTrade(config, decision.signal, nextCandle, now);
  if (isNoTradeWindowActive(nextCandle.openTime)) {
    trackStrategyOnlyTrade(trade);
    markEarlyEntryTargetDone(nextCandle.openTime);
    return;
  }

  const opened = await openTrade(trade, currentCandle.openTime);
  if (opened) {
    markEarlyEntryTargetDone(nextCandle.openTime);
    trackPendingEarlyEntry(nextCandle.openTime, stage.name === "final");
  }
}

async function maybeValidatePendingEarlyEntry(currentCandle: Candle, now: number): Promise<void> {
  if (!pendingTrade || !pendingEarlyEntryTargetOpenTime || pendingEarlyEntryFinalValidationDone) {
    return;
  }

  if (now > currentCandle.closeTime) {
    return;
  }

  const nextCandle = getNextCandlePlaceholder(currentCandle);
  if (pendingEarlyEntryTargetOpenTime !== nextCandle.openTime || pendingTrade.candleOpenTime !== nextCandle.openTime) {
    return;
  }

  const secondsLeft = secondsUntilCandleClose(currentCandle, now);
  if (secondsLeft > config.earlyEntryOrderSecondsBeforeClose) {
    return;
  }

  const decision = strategy.getEarlySignalForNextCandle(currentCandle, {
    label: "final early-entry validation",
    minMovePct: null,
  });

  if (!decision.signal) {
    await cancelInvalidatedPendingEarlyEntry(currentCandle, decision.reason);
    return;
  }

  if (decision.signal.direction !== pendingTrade.direction || decision.signal.kind !== pendingTrade.kind) {
    await cancelInvalidatedPendingEarlyEntry(
      currentCandle,
      `expected ${pendingTrade.kind} ${pendingTrade.direction}, got ${decision.signal.kind} ${decision.signal.direction}`
    );
    return;
  }

  pendingEarlyEntryFinalValidationDone = true;
}

async function processNewClosedCandles(closedCandles: Candle[]): Promise<void> {
  const newClosedCandles = closedCandles.filter((candle) => candle.openTime > lastProcessedClosedCandleOpenTime);

  for (const candle of newClosedCandles) {
    if (pendingStrategyOnlyTrade && pendingStrategyOnlyTrade.candleOpenTime === candle.openTime) {
      const strategyOnlyTrade = resolvePaperTrade(pendingStrategyOnlyTrade, candle);
      logSkip(
        `${new Date(candle.openTime).toISOString()} no-trade window strategy-only signal resolved as hypothetical ${strategyOnlyTrade.result}`
      );
      strategy.recordTradeResult(strategyOnlyTrade, candle);
      pendingStrategyOnlyTrade = null;
    } else if (pendingTrade && pendingTrade.candleOpenTime === candle.openTime) {
      await refreshPendingLiveOrderFillStatus();
      if (liveExecutor && pendingLiveOrder && !pendingLiveOrder.filled) {
        await cancelPendingLiveOrder();
      }
      if (liveExecutor && pendingLiveOrder && !pendingLiveOrder.filled) {
        const strategyOnlyTrade = resolvePaperTrade(pendingTrade, candle);
        if (hasPartialLiveFill(pendingLiveOrder)) {
          const realizedLiveOrder = liveOrderForFilledPortion(pendingLiveOrder);
          const realizedTrade = resolvePaperTrade(resizeTradeToLiveFill(pendingTrade, realizedLiveOrder), candle);
          logSkip(
            `${new Date(candle.openTime).toISOString()} live order was partially filled${liveFillProgress(pendingLiveOrder)}; logging realized partial trade and updating strategy state as ${strategyOnlyTrade.result}`
          );
          logResult(realizedTrade);
          writeLocalTradeLogs(realizedTrade, realizedLiveOrder);
          await syncGoogleSheetsTrade(realizedTrade, realizedLiveOrder);
          await syncGoogleSheetsOrderEvent(
            "ORDER_NOT_FILLED",
            pendingTrade,
            pendingLiveOrder,
            "Order was partially filled by candle close and logged proportionally"
          );
          strategy.recordTradeResult(strategyOnlyTrade, candle);
          riskManager.recordResolvedTrade(realizedTrade);
          pendingTrade = null;
          pendingLiveOrder = null;
          clearPendingEarlyEntryTracking();
          lastProcessedClosedCandleOpenTime = candle.openTime;
          continue;
        }

        logSkip(
          `${new Date(candle.openTime).toISOString()} live order was not fully filled${liveFillProgress(pendingLiveOrder)}; strategy state updates as hypothetical ${strategyOnlyTrade.result}`
        );
        await syncGoogleSheetsOrderEvent(
          "ORDER_NOT_FILLED",
          pendingTrade,
          pendingLiveOrder,
          "Order was not fully filled by candle close"
        );
        strategy.recordTradeResult(strategyOnlyTrade, candle);
        pendingTrade = null;
        pendingLiveOrder = null;
        clearPendingEarlyEntryTracking();
        lastProcessedClosedCandleOpenTime = candle.openTime;
        continue;
      }

      const resolvedTrade = resolvePaperTrade(pendingTrade, candle);
      logResult(resolvedTrade);
      writeLocalTradeLogs(resolvedTrade, pendingLiveOrder);
      await syncGoogleSheetsTrade(resolvedTrade, pendingLiveOrder);
      if (liveExecutor && pendingLiveOrder) {
        await syncGoogleSheetsOrderEvent("ORDER_FILLED", pendingTrade, pendingLiveOrder, "Order was fully filled and logged as a trade");
      }
      strategy.recordTradeResult(resolvedTrade, candle);
      riskManager.recordResolvedTrade(resolvedTrade);
      pendingTrade = null;
      pendingLiveOrder = null;
      clearPendingEarlyEntryTracking();
    } else {
      strategy.processClosedCandleWithoutTrade(candle);
    }

    logStartupSkippedCandleClosed(candle);
    lastProcessedClosedCandleOpenTime = candle.openTime;
  }
}

async function tick(): Promise<void> {
  const candles = await fetchCandles(config, config.candleLimit);
  const now = Date.now();
  if (candles.length === 0) {
    logInsufficientCandles(candles.length, now);
    return;
  }

  const currentCandle = candles[candles.length - 1];
  const closedCandles = candles.slice(0, -1);
  const intervalMs = currentCandle.closeTime - currentCandle.openTime + 1;
  const requiredPreviousClosedOpenTime = currentCandle.openTime - intervalMs;

  if (candles.length < 4 && !initialized) {
    logInsufficientCandles(candles.length, now);
    return;
  }

  if (!initialized) {
    warmUpStrategy(closedCandles);
    skipStartupCandle(currentCandle);
    return;
  } else {
    await processNewClosedCandles(closedCandles);
  }

  await cancelPendingLiveOrderIfDue(now);

  if (lastProcessedClosedCandleOpenTime < requiredPreviousClosedOpenTime) {
    logWaitingForOfficialClosedCandle(requiredPreviousClosedOpenTime, now);
    return;
  }

  await maybeValidatePendingEarlyEntry(currentCandle, now);
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

  if (pendingTrade || pendingStrategyOnlyTrade) {
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
  if (isNoTradeWindowActive(currentCandle.openTime)) {
    trackStrategyOnlyTrade(trade);
    lastHandledCandleOpenTime = currentCandle.openTime;
    return;
  }

  await openTrade(trade, currentCandle.openTime);

  lastHandledCandleOpenTime = currentCandle.openTime;
}

async function main(): Promise<void> {
  initializeLocalCsvLogs();
  logStartup(config);
  await initializeGoogleSheets();

  while (!shuttingDown) {
    try {
      await tick();
    } catch (error) {
      logError(error);
      if (runOnce) {
        process.exitCode = 1;
        closePolymarketChainlinkCandleSources();
        return;
      }
    }

    if (runOnce) {
      closePolymarketChainlinkCandleSources();
      return;
    }

    await sleep(config.pollMs);
  }

  await cancelPendingLiveOrder();
  closePolymarketChainlinkCandleSources();
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
