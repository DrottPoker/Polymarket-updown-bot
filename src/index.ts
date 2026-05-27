import { loadConfig } from "./config/appConfig";
import { Candle, LiveOrder, OrderEvent, OrderEventType, PaperTrade, ResolvedPaperTrade } from "./domain/types";
import {
  appendOrderEvent,
  appendTradeResult,
  ensureCsvLog,
  ensureOrderEventsCsvLog,
  logCandleCorrection,
  logCandleDecision,
  logError,
  logLiveCancel,
  logLiveDryRun,
  logLiveFill,
  logLiveOrder,
  logRecentClosedCandles,
  logResult,
  logSignal,
  logSkip,
  logStartup,
  logWarmup,
  readCsvRows,
  refreshStatsLog,
} from "./logging/logger";
import { GoogleSheetsLogger } from "./logging/googleSheetsLogger";
import { fetchCandles } from "./marketData/candles";
import { closePolymarketChainlinkCandleSources } from "./marketData/polymarketChainlinkCandles";
import { PolymarketLiveExecutor } from "./polymarket/liveExecutor";
import { PendingLiveTradeState, PendingSettlementState, RuntimeState, RuntimeStateStore } from "./state/runtimeStateStore";
import {
  createPaperTrade,
  resizeTradeToLiveFill,
  resizeTradeToUnfilledLiveRemainder,
  resolvePaperTrade,
} from "./trading/paperBroker";
import { RuntimeRiskManager } from "./trading/riskManager";
import {
  getEarlyEntryStages as buildEarlyEntryStages,
  markDueEarlyEntryStagesAttempted,
  selectDueEarlyEntryStage,
} from "./trading/earlyEntryStages";
import { TradingViewReversalStrategy } from "./trading/strategy";

const config = loadConfig();
const runOnce = process.env.RUN_ONCE === "1" || process.env.RUN_ONCE?.toLowerCase() === "true";
if (config.executionMode === "live" && runOnce) {
  throw new Error("RUN_ONCE is disabled in live mode because open orders need ongoing cancel/fill tracking");
}

const runtimeStateStore = new RuntimeStateStore(config);
let runtimeState: RuntimeState = runtimeStateStore.load();
const strategy = new TradingViewReversalStrategy(config);
const riskManager = new RuntimeRiskManager(config, runtimeState.risk ?? undefined);
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
let lastClosedCandleDataWaitOpenTime = 0;
let lastPendingTradeSkipOpenTime = 0;
let lastDecisionLogTargetOpenTime = 0;
let lastOfficialSettlementWaitOpenTime = 0;
const processedClosedCandlesByOpenTime = new Map<number, Candle>();
const processedTradeInputsByOpenTime = new Map<number, PaperTrade>();
const pendingSettlementsByOpenTime = new Map<number, PendingSettlementState>(
  runtimeState.pendingSettlements.map((settlement) => [settlement.trade.candleOpenTime, settlement])
);
const historicalWarmupOpenTimes = new Set<number>();
let googleSheetsQueue: Promise<void> = Promise.resolve();
let shuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentPendingLiveTradeState(): PendingLiveTradeState | null {
  if (!pendingTrade || !pendingLiveOrder) {
    return null;
  }

  return {
    trade: pendingTrade,
    liveOrder: pendingLiveOrder,
    earlyEntryTargetOpenTime: pendingEarlyEntryTargetOpenTime,
    earlyEntryFinalValidationDone: pendingEarlyEntryFinalValidationDone,
  };
}

function persistRuntimeState(): void {
  runtimeState = {
    version: 1,
    updatedAt: new Date().toISOString(),
    risk: riskManager.getSnapshot(),
    pendingLiveTrade: currentPendingLiveTradeState(),
    pendingSettlements: Array.from(pendingSettlementsByOpenTime.values()),
  };
  runtimeStateStore.save(runtimeState);
}

function persistPendingLiveTradeState(): void {
  if (config.executionMode === "live") {
    persistRuntimeState();
  }
}

function clearPersistedPendingLiveTradeState(): void {
  if (config.executionMode !== "live") {
    return;
  }

  runtimeState = {
    ...runtimeState,
    risk: riskManager.getSnapshot(),
    pendingLiveTrade: null,
    pendingSettlements: Array.from(pendingSettlementsByOpenTime.values()),
  };
  runtimeStateStore.save(runtimeState);
}

function queueGoogleSheetsTask(task: () => Promise<void>): void {
  if (!googleSheetsLogger) {
    return;
  }

  googleSheetsQueue = googleSheetsQueue
    .then(task)
    .catch(async (error) => {
      logError(error);
      try {
        await sleep(1_000);
        await reconcileGoogleSheetsFromLocalCsv("recovering after failed Google Sheets write", true, true);
      } catch (reconcileError) {
        logError(reconcileError);
      }
    });
}

async function drainGoogleSheetsQueue(timeoutMs: number): Promise<void> {
  await Promise.race([googleSheetsQueue, sleep(timeoutMs)]);
}

async function reconcileGoogleSheetsFromLocalCsv(
  reason: string,
  refreshStats: boolean,
  allowEmptySheetBackfill = false
): Promise<void> {
  const logger = googleSheetsLogger;
  if (!logger) {
    return;
  }

  const result = await logger.reconcileLocalCsvLogs(
    config.localCsvLoggingEnabled ? readCsvRows(config.logFile) : [],
    config.localCsvLoggingEnabled ? readCsvRows(config.orderEventsFile) : [],
    { allowEmptySheetBackfill, refreshStats }
  );
  if (result.tradesAppended > 0 || result.orderEventsAppended > 0) {
    logSkip(
      `Google Sheets local CSV reconciliation appended ${result.tradesAppended} trade row(s) and ${result.orderEventsAppended} order event row(s): ${reason}`
    );
  }
}

function secondsIntoCandle(candle: Candle, now: number): number {
  return Math.max(0, Math.floor((now - candle.openTime) / 1000));
}

function secondsUntilCandleClose(candle: Candle, now: number): number {
  return Math.max(0, Math.ceil((candle.closeTime - now) / 1000));
}

function getEarlyEntryStages() {
  return buildEarlyEntryStages(config);
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
  return `${candle.color} open=${candle.open.toFixed(2)} close=${candle.close.toFixed(2)} source=${
    candle.settlement ?? "official"
  }`;
}

function hasClosedCandleForDecision(requiredOpenTime: number): boolean {
  return lastProcessedClosedCandleOpenTime >= requiredOpenTime;
}

function logInsufficientCandles(candleCount: number, now: number): void {
  if (now - lastInsufficientCandlesLogTime < 30_000) {
    return;
  }

  lastInsufficientCandlesLogTime = now;
  logSkip(`Waiting for at least 4 Polymarket candles; received ${candleCount}`);
}

function logWaitingForClosedCandleData(openTime: number): void {
  if (lastClosedCandleDataWaitOpenTime === openTime) {
    return;
  }

  lastClosedCandleDataWaitOpenTime = openTime;
  logSkip(`${new Date(openTime).toISOString()} waiting for latest closed candle data before entry decision`);
}

function liveFillProgress(order: LiveOrder | null): string {
  if (order?.fillStatus === "unknown") {
    return `; fill status unknown${order.fillError ? ` (${order.fillError})` : ""}`;
  }

  if (!order || !order.filledSize || order.filledSize <= 0) {
    return "";
  }

  return `; matched ${order.filledSize.toFixed(4)} of ${order.size.toFixed(4)} shares`;
}

function liveFilledSize(order: LiveOrder | null): number {
  if (!order || order.fillStatus === "unknown" || !order.filledSize || order.filledSize <= 0) {
    return 0;
  }

  const filledSize = Math.min(order.filledSize, order.size);
  return order.size - filledSize <= config.liveFullFillToleranceShares ? order.size : filledSize;
}

function hasPartialLiveFill(order: LiveOrder | null): boolean {
  return Boolean(order && order.fillStatus !== "unknown" && !order.filled && liveFilledSize(order) > 0);
}

function formatLivePrice(price: number | undefined): string {
  return price === undefined ? "unknown" : `${(price * 100).toFixed(2)}c`;
}

function liveOrderEntryDetail(order: LiveOrder): string {
  let mode = "limit entry";
  if (order.postOnly === true) {
    mode = "post-only maker entry";
  } else if (order.requestedPrice !== undefined && Math.abs(order.requestedPrice - order.price) > 1e-9) {
    mode = "taker fallback entry";
  }
  const selected = formatLivePrice(order.price);
  if (order.requestedPrice !== undefined && Math.abs(order.requestedPrice - order.price) > 1e-9) {
    return `${mode}; selected ${selected} from requested ${formatLivePrice(
      order.requestedPrice
    )}; best ask at post was ${formatLivePrice(order.bestAskAtPost)}`;
  }

  return `${mode}; selected ${selected}; best ask at post was ${formatLivePrice(order.bestAskAtPost)}`;
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

function liveOrderForPartialOrderEvent(order: LiveOrder): LiveOrder {
  return {
    ...order,
    filledSize: liveFilledSize(order),
    filled: false,
    status: "partial",
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

function candlesDiffer(left: Candle, right: Candle): boolean {
  return (
    left.open !== right.open ||
    left.high !== right.high ||
    left.low !== right.low ||
    left.close !== right.close ||
    left.color !== right.color ||
    (left.settlement ?? "official") !== (right.settlement ?? "official")
  );
}

function shouldWaitForOfficialSettlement(candle: Candle): boolean {
  return config.priceSource === "polymarket_chainlink" && candle.settlement === "provisional";
}

function logWaitingForOfficialSettlement(openTime: number, reason: string): void {
  if (lastOfficialSettlementWaitOpenTime === openTime) {
    return;
  }

  lastOfficialSettlementWaitOpenTime = openTime;
  logSkip(`${new Date(openTime).toISOString()} waiting for official settlement before ${reason}`);
}

function rememberProcessedClosedCandle(candle: Candle): void {
  processedClosedCandlesByOpenTime.set(candle.openTime, candle);
}

function moveActivePendingTradeToSettlement(settlement: PendingSettlementState): void {
  pendingSettlementsByOpenTime.set(settlement.trade.candleOpenTime, settlement);
  pendingTrade = null;
  pendingLiveOrder = null;
  clearPendingEarlyEntryTracking();
  clearPersistedPendingLiveTradeState();
}

function clearPendingSettlement(openTime: number): void {
  pendingSettlementsByOpenTime.delete(openTime);
  persistRuntimeState();
}

function rebuildStrategyFromProcessedHistory(): void {
  strategy.reset();
  const processedCandles = Array.from(processedClosedCandlesByOpenTime.values())
    .filter((candle) => candle.openTime <= lastProcessedClosedCandleOpenTime)
    .sort((a, b) => a.openTime - b.openTime);

  for (const candle of processedCandles) {
    const trade = processedTradeInputsByOpenTime.get(candle.openTime);
    if (trade) {
      strategy.recordTradeResult(resolvePaperTrade(trade, candle), candle);
      continue;
    }

    if (historicalWarmupOpenTimes.has(candle.openTime)) {
      strategy.warmUp([candle]);
      continue;
    }

    strategy.processClosedCandleWithoutTrade(candle);
  }
}

function processOfficialClosedCandleCorrections(closedCandles: Candle[]): void {
  for (const candle of closedCandles) {
    if (candle.settlement === "provisional") {
      continue;
    }

    const previous = processedClosedCandlesByOpenTime.get(candle.openTime);
    if (!previous || previous.settlement !== "provisional" || !candlesDiffer(previous, candle)) {
      continue;
    }

    rememberProcessedClosedCandle(candle);
    rebuildStrategyFromProcessedHistory();
    logCandleCorrection(previous, candle);
    syncGoogleSheetsCandles([candle]);
  }
}

function liveOrderForSettlementOrderEvent(settlement: PendingSettlementState): LiveOrder | null | undefined {
  if (settlement.orderEventLiveOrder) {
    return settlement.orderEventLiveOrder;
  }

  if (
    settlement.orderEventType === "ORDER_NOT_FILLED" &&
    settlement.realizedLiveOrder?.status === "partial" &&
    settlement.realizedLiveOrder.size < settlement.trade.shares
  ) {
    return {
      ...settlement.realizedLiveOrder,
      filled: false,
      filledSize: settlement.realizedLiveOrder.size,
      size: settlement.trade.shares,
    };
  }

  return settlement.realizedLiveOrder;
}

function resolveMissedSettlementTrade(settlement: PendingSettlementState, candle: Candle): ResolvedPaperTrade | undefined {
  if (settlement.orderEventType !== "ORDER_NOT_FILLED") {
    return undefined;
  }

  if (settlement.missedTrade) {
    return resolvePaperTrade(settlement.missedTrade, candle);
  }

  if (
    settlement.realizedLiveOrder?.status === "partial" &&
    settlement.realizedLiveOrder.size < settlement.trade.shares
  ) {
    return resolvePaperTrade(
      resizeTradeToUnfilledLiveRemainder(settlement.trade, {
        ...settlement.realizedLiveOrder,
        filledSize: settlement.realizedLiveOrder.size,
        size: settlement.trade.shares,
      }),
      candle
    );
  }

  return resolvePaperTrade(settlement.trade, candle);
}

function finalizePendingSettlement(candle: Candle, settlement: PendingSettlementState): void {
  if (settlement.shouldLogTrade) {
    const tradeForLog = settlement.realizedLiveOrder
      ? resizeTradeToLiveFill(settlement.trade, settlement.realizedLiveOrder)
      : settlement.trade;
    const resolvedTrade = resolvePaperTrade(tradeForLog, candle);
    logResult(resolvedTrade);
    writeLocalTradeLogs(resolvedTrade, settlement.realizedLiveOrder);
    syncGoogleSheetsTrade(resolvedTrade, settlement.realizedLiveOrder);
    if (settlement.orderEventType) {
      const missedTrade = resolveMissedSettlementTrade(settlement, candle);
      syncGoogleSheetsOrderEvent(
        settlement.orderEventType,
        settlement.trade,
        liveOrderForSettlementOrderEvent(settlement),
        settlement.orderEventDetail,
        missedTrade
      );
    }
    riskManager.recordResolvedTrade(resolvedTrade);
  }

  clearPendingSettlement(candle.openTime);
}

function settleProcessedOfficialSettlements(closedCandles: Candle[]): void {
  for (const candle of closedCandles) {
    if (candle.settlement === "provisional") {
      continue;
    }

    if (candle.openTime > lastProcessedClosedCandleOpenTime) {
      continue;
    }

    const settlement = pendingSettlementsByOpenTime.get(candle.openTime);
    if (!settlement) {
      continue;
    }

    finalizePendingSettlement(candle, settlement);
  }
}

function warmUpStrategy(closedCandles: Candle[]): void {
  if (initialized) {
    return;
  }

  strategy.warmUp(closedCandles);
  for (const candle of closedCandles) {
    rememberProcessedClosedCandle(candle);
    historicalWarmupOpenTimes.add(candle.openTime);
  }
  syncGoogleSheetsCandles(closedCandles);
  lastProcessedClosedCandleOpenTime = closedCandles[closedCandles.length - 1]?.openTime ?? 0;
  initialized = true;
  logWarmup(closedCandles.length);
  logRecentClosedCandles(strategy.getRecentProcessedCandles(5), strategy.getRecentTrendColors(5));
}

function skipStartupCandle(currentCandle: Candle): void {
  startupSkippedCandleOpenTime = currentCandle.openTime;
  lastHandledCandleOpenTime = currentCandle.openTime;
  logSkip(
    `${new Date(
      currentCandle.openTime
    ).toISOString()} startup candle is already in progress; direct entry on this candle is disabled, early entry for the next candle remains enabled`
  );
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
    persistPendingLiveTradeState();
  } catch (error) {
    logError(error);
  }
}

function writeLocalOrderEvent(event: OrderEvent): void {
  if (!config.localCsvLoggingEnabled) {
    return;
  }

  appendOrderEvent(config.orderEventsFile, event);
}

function syncGoogleSheetsOrderEvent(
  eventType: OrderEventType,
  trade: PaperTrade,
  liveOrder?: LiveOrder | null,
  detail?: string,
  missedTrade?: ResolvedPaperTrade | null
): void {
  const event: OrderEvent = {
    eventTime: Date.now(),
    eventType,
    trade,
    liveOrder,
    missedTrade,
    detail,
  };

  try {
    writeLocalOrderEvent(event);
  } catch (error) {
    logError(error);
  }

  const logger = googleSheetsLogger;
  if (!logger) {
    return;
  }

  queueGoogleSheetsTask(async () => {
    await logger.appendOrderEvent(event);
  });
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
    persistPendingLiveTradeState();
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
    persistPendingLiveTradeState();
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
    clearPersistedPendingLiveTradeState();
    return;
  }

  await refreshPendingLiveOrderFillStatus();
  if (pendingLiveOrder.filled) {
    logSkip(
      `${new Date(currentCandle.openTime).toISOString()} final early-entry validation failed, but live order is already filled; trade will be managed to candle close`
    );
    pendingEarlyEntryFinalValidationDone = true;
    persistPendingLiveTradeState();
    return;
  }

  await cancelPendingLiveOrder();
  const orderAfterCancel = pendingLiveOrder;
  if (orderAfterCancel?.filled) {
    logSkip(
      `${new Date(currentCandle.openTime).toISOString()} final early-entry validation failed, but live order filled before cancel completed; trade will be managed to candle close`
    );
    pendingEarlyEntryFinalValidationDone = true;
    return;
  }

  if (orderAfterCancel?.fillStatus === "unknown") {
    logSkip(
      `${new Date(currentCandle.openTime).toISOString()} final early-entry validation failed, but live fill status is unknown${liveFillProgress(
        orderAfterCancel
      )}; trade will remain pending until fill status is known`
    );
    pendingEarlyEntryFinalValidationDone = true;
    persistPendingLiveTradeState();
    return;
  }

  if (orderAfterCancel && hasPartialLiveFill(orderAfterCancel)) {
    logSkip(
      `${new Date(currentCandle.openTime).toISOString()} final early-entry validation failed, but live order was partially filled${liveFillProgress(
        orderAfterCancel
      )}; filled portion will be managed to candle close`
    );
    pendingEarlyEntryFinalValidationDone = true;
    persistPendingLiveTradeState();
    return;
  }

  if (orderAfterCancel?.canceled) {
    syncGoogleSheetsOrderEvent("FINAL_CHECK_CANCELED", pendingTrade, orderAfterCancel, reason);
    pendingTrade = null;
    pendingLiveOrder = null;
    clearPendingEarlyEntryTracking();
    clearPersistedPendingLiveTradeState();
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
      persistRuntimeState();
      logLiveOrder(pendingLiveOrder);
      syncGoogleSheetsOrderEvent("ORDER_PLACED", trade, pendingLiveOrder, liveOrderEntryDetail(pendingLiveOrder));
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
    await reconcileGoogleSheetsFromLocalCsv("startup sync", true);
  } catch (error) {
    logError(error);
  }
}

function syncGoogleSheetsTrade(trade: ResolvedPaperTrade, liveOrder?: LiveOrder | null): void {
  const logger = googleSheetsLogger;
  if (!logger) {
    return;
  }

  queueGoogleSheetsTask(async () => {
    await logger.appendTradeResult(trade, liveOrder);
    await logger.refreshStats();
  });
}

function syncGoogleSheetsCandles(candles: Candle[]): void {
  const logger = googleSheetsLogger;
  if (!logger || candles.length === 0) {
    return;
  }

  queueGoogleSheetsTask(async () => {
    try {
      await logger.upsertCandles(candles);
    } catch (error) {
      logError(error);
      await sleep(1_000);
      await logger.upsertCandles(candles);
    }
  });
}

function initializeLocalCsvLogs(): void {
  if (!config.localCsvLoggingEnabled) {
    return;
  }

  ensureCsvLog(config.logFile);
  ensureOrderEventsCsvLog(config.orderEventsFile);
  refreshStatsLog(config.logFile, config.statsFile);
}

function writeLocalTradeLogs(trade: ResolvedPaperTrade, liveOrder?: LiveOrder | null): void {
  if (!config.localCsvLoggingEnabled) {
    return;
  }

  appendTradeResult(config.logFile, trade, liveOrder);
  refreshStatsLog(config.logFile, config.statsFile);
}

function earliestPendingStateOpenTime(): number | null {
  const openTimes = [
    pendingTrade?.candleOpenTime,
    ...Array.from(pendingSettlementsByOpenTime.values()).map((settlement) => settlement.trade.candleOpenTime),
  ].filter((openTime): openTime is number => typeof openTime === "number");

  return openTimes.length > 0 ? Math.min(...openTimes) : null;
}

async function recoverPersistedPendingLiveTrade(): Promise<void> {
  const pendingState = runtimeState.pendingLiveTrade;
  if (!pendingState) {
    return;
  }

  if (config.executionMode !== "live") {
    logSkip(
      `Ignoring persisted live order ${pendingState.liveOrder.orderId ?? "unknown"} because execution mode is ${config.executionMode}`
    );
    return;
  }

  pendingTrade = pendingState.trade;
  pendingLiveOrder = {
    ...pendingState.liveOrder,
    fillStatus: pendingState.liveOrder.fillStatus ?? "known",
  };
  pendingEarlyEntryTargetOpenTime = pendingState.earlyEntryTargetOpenTime;
  pendingEarlyEntryFinalValidationDone = pendingState.earlyEntryFinalValidationDone;
  logSkip(
    `${new Date(pendingTrade.candleOpenTime).toISOString()} recovered pending live order ${
      pendingLiveOrder.orderId ?? "unknown"
    } from ${config.runtimeStateFile}; new entries are blocked until it is resolved`
  );

  await refreshPendingLiveOrderFillStatus();
  await cancelPendingLiveOrderIfDue(Date.now());
}

async function maybeOpenEarlyEntry(
  currentCandle: Candle,
  now: number,
  decisionStrategy: TradingViewReversalStrategy
): Promise<void> {
  if (!config.earlyEntryEnabled || pendingTrade || pendingStrategyOnlyTrade) {
    return;
  }

  if (now > currentCandle.closeTime) {
    return;
  }

  const nextCandle = getNextCandlePlaceholder(currentCandle);
  resetEarlyEntryAttemptsForTarget(nextCandle.openTime);

  const secondsLeft = secondsUntilCandleClose(currentCandle, now);
  const stages = getEarlyEntryStages();
  const stage = selectDueEarlyEntryStage(stages, earlyEntryAttemptedStages, secondsLeft);
  if (!stage) {
    return;
  }

  markDueEarlyEntryStagesAttempted(stages, earlyEntryAttemptedStages, stage);

  const decision = decisionStrategy.getEarlySignalForNextCandle(currentCandle, {
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

async function maybeValidatePendingEarlyEntry(
  currentCandle: Candle,
  now: number,
  decisionStrategy: TradingViewReversalStrategy
): Promise<void> {
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

  const decision = decisionStrategy.getEarlySignalForNextCandle(currentCandle, {
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

function finishProcessedClosedCandle(candle: Candle): void {
  const targetOpenTime = candle.closeTime + 1;
  logStartupSkippedCandleClosed(candle);
  rememberProcessedClosedCandle(candle);
  syncGoogleSheetsCandles([candle]);
  logCandleDecision(candle, strategy.getRecentTrendColors(5), strategy.getSignalForNextCandle(), targetOpenTime);
  lastDecisionLogTargetOpenTime = targetOpenTime;
  lastProcessedClosedCandleOpenTime = candle.openTime;
}

async function processNewClosedCandles(closedCandles: Candle[]): Promise<void> {
  processOfficialClosedCandleCorrections(closedCandles);
  settleProcessedOfficialSettlements(closedCandles);

  const newClosedCandles = closedCandles.filter((candle) => candle.openTime > lastProcessedClosedCandleOpenTime);

  for (const candle of newClosedCandles) {
    const pendingSettlement = pendingSettlementsByOpenTime.get(candle.openTime);
    if (pendingSettlement) {
      const strategyTrade = resolvePaperTrade(pendingSettlement.trade, candle);
      strategy.recordTradeResult(strategyTrade, candle);
      processedTradeInputsByOpenTime.set(candle.openTime, pendingSettlement.trade);
      if (candle.settlement === "provisional") {
        logWaitingForOfficialSettlement(candle.openTime, "writing final trade log");
      } else {
        finalizePendingSettlement(candle, pendingSettlement);
      }
    } else if (pendingStrategyOnlyTrade && pendingStrategyOnlyTrade.candleOpenTime === candle.openTime) {
      const strategyOnlyTrade = resolvePaperTrade(pendingStrategyOnlyTrade, candle);
      logSkip(
        `${new Date(candle.openTime).toISOString()} no-trade window strategy-only signal resolved as hypothetical ${strategyOnlyTrade.result}`
      );
      processedTradeInputsByOpenTime.set(candle.openTime, pendingStrategyOnlyTrade);
      strategy.recordTradeResult(strategyOnlyTrade, candle);
      pendingStrategyOnlyTrade = null;
    } else if (pendingTrade && pendingTrade.candleOpenTime === candle.openTime) {
      const deferOfficialSettlement = shouldWaitForOfficialSettlement(candle);
      if (deferOfficialSettlement) {
        logWaitingForOfficialSettlement(candle.openTime, "writing final trade log");
      }

      await refreshPendingLiveOrderFillStatus();
      if (liveExecutor && pendingLiveOrder && !pendingLiveOrder.filled) {
        await cancelPendingLiveOrder();
      }
      if (liveExecutor && pendingLiveOrder?.fillStatus === "unknown") {
        logSkip(
          `${new Date(candle.openTime).toISOString()} live order fill status is unknown${liveFillProgress(
            pendingLiveOrder
          )}; trade resolution is paused until CLOB fill status is known`
        );
        persistPendingLiveTradeState();
        return;
      }
      if (liveExecutor && pendingLiveOrder && !pendingLiveOrder.filled) {
        const strategyOnlyTrade = resolvePaperTrade(pendingTrade, candle);
        if (hasPartialLiveFill(pendingLiveOrder)) {
          const realizedLiveOrder = liveOrderForFilledPortion(pendingLiveOrder);
          const partialOrderEvent = liveOrderForPartialOrderEvent(pendingLiveOrder);
          const missedTradeInput = resizeTradeToUnfilledLiveRemainder(pendingTrade, pendingLiveOrder);
          const missedTrade = resolvePaperTrade(missedTradeInput, candle);
          if (deferOfficialSettlement) {
            logSkip(
              `${new Date(candle.openTime).toISOString()} live order was partially filled${liveFillProgress(
                pendingLiveOrder
              )}; strategy state updates as provisional ${strategyOnlyTrade.result} and final trade log is deferred`
            );
          } else {
            const realizedTrade = resolvePaperTrade(resizeTradeToLiveFill(pendingTrade, realizedLiveOrder), candle);
            logSkip(
              `${new Date(candle.openTime).toISOString()} live order was partially filled${liveFillProgress(pendingLiveOrder)}; logging realized partial trade and updating strategy state as ${strategyOnlyTrade.result}`
            );
            logResult(realizedTrade);
            writeLocalTradeLogs(realizedTrade, realizedLiveOrder);
            syncGoogleSheetsTrade(realizedTrade, realizedLiveOrder);
            syncGoogleSheetsOrderEvent(
              "ORDER_NOT_FILLED",
              pendingTrade,
              partialOrderEvent,
              "Order was partially filled by candle close and logged proportionally",
              missedTrade
            );
            riskManager.recordResolvedTrade(realizedTrade);
          }
          strategy.recordTradeResult(strategyOnlyTrade, candle);
          processedTradeInputsByOpenTime.set(candle.openTime, pendingTrade);
          if (deferOfficialSettlement) {
            moveActivePendingTradeToSettlement({
              trade: pendingTrade,
              realizedLiveOrder,
              shouldLogTrade: true,
              orderEventType: "ORDER_NOT_FILLED",
              orderEventDetail: "Order was partially filled by candle close and logged proportionally after official settlement",
              orderEventLiveOrder: partialOrderEvent,
              missedTrade: missedTradeInput,
            });
          } else {
            pendingTrade = null;
            pendingLiveOrder = null;
            clearPendingEarlyEntryTracking();
            clearPersistedPendingLiveTradeState();
          }
          finishProcessedClosedCandle(candle);
          continue;
        }

        logSkip(
          `${new Date(candle.openTime).toISOString()} live order was not fully filled${liveFillProgress(pendingLiveOrder)}; strategy state updates as hypothetical ${strategyOnlyTrade.result}`
        );
        const missedTrade = resolvePaperTrade(resizeTradeToUnfilledLiveRemainder(pendingTrade, pendingLiveOrder), candle);
        syncGoogleSheetsOrderEvent(
          "ORDER_NOT_FILLED",
          pendingTrade,
          pendingLiveOrder,
          "Order was not fully filled by candle close",
          missedTrade
        );
        strategy.recordTradeResult(strategyOnlyTrade, candle);
        processedTradeInputsByOpenTime.set(candle.openTime, pendingTrade);
        pendingTrade = null;
        pendingLiveOrder = null;
        clearPendingEarlyEntryTracking();
        clearPersistedPendingLiveTradeState();
        finishProcessedClosedCandle(candle);
        continue;
      }

      if (deferOfficialSettlement) {
        const strategyTrade = resolvePaperTrade(pendingTrade, candle);
        logSkip(
          `${new Date(candle.openTime).toISOString()} trade result is provisional ${strategyTrade.result}; strategy state advances and final trade log is deferred`
        );
        strategy.recordTradeResult(strategyTrade, candle);
        processedTradeInputsByOpenTime.set(candle.openTime, pendingTrade);
        moveActivePendingTradeToSettlement({
          trade: pendingTrade,
          realizedLiveOrder: pendingLiveOrder,
          shouldLogTrade: true,
          orderEventType: liveExecutor && pendingLiveOrder ? "ORDER_FILLED" : undefined,
          orderEventDetail:
            liveExecutor && pendingLiveOrder ? "Order was fully filled and logged after official settlement" : undefined,
        });
        finishProcessedClosedCandle(candle);
        continue;
      }

      const tradeForLog = pendingLiveOrder ? resizeTradeToLiveFill(pendingTrade, pendingLiveOrder) : pendingTrade;
      const resolvedTrade = resolvePaperTrade(tradeForLog, candle);
      logResult(resolvedTrade);
      writeLocalTradeLogs(resolvedTrade, pendingLiveOrder);
      syncGoogleSheetsTrade(resolvedTrade, pendingLiveOrder);
      if (liveExecutor && pendingLiveOrder) {
        syncGoogleSheetsOrderEvent("ORDER_FILLED", pendingTrade, pendingLiveOrder, "Order was fully filled and logged as a trade");
      }
      strategy.recordTradeResult(resolvedTrade, candle);
      processedTradeInputsByOpenTime.set(candle.openTime, pendingTrade);
      riskManager.recordResolvedTrade(resolvedTrade);
      pendingTrade = null;
      pendingLiveOrder = null;
      clearPendingEarlyEntryTracking();
      clearPersistedPendingLiveTradeState();
    } else {
      strategy.processClosedCandleWithoutTrade(candle);
    }

    finishProcessedClosedCandle(candle);
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

  if (closedCandles.length < 3 && !initialized) {
    logInsufficientCandles(closedCandles.length + 1, now);
    return;
  }

  if (!initialized) {
    const earliestPendingOpenTime = earliestPendingStateOpenTime();
    const warmupCandles = earliestPendingOpenTime
      ? closedCandles.filter((candle) => candle.openTime < earliestPendingOpenTime)
      : closedCandles;
    warmUpStrategy(warmupCandles);
    skipStartupCandle(currentCandle);
    if (earliestPendingOpenTime) {
      await processNewClosedCandles(closedCandles);
    }
    return;
  } else {
    await processNewClosedCandles(closedCandles);
  }

  await refreshPendingLiveOrderFillStatus();
  await cancelPendingLiveOrderIfDue(now);

  if (!hasClosedCandleForDecision(requiredPreviousClosedOpenTime)) {
    logWaitingForClosedCandleData(requiredPreviousClosedOpenTime);
    return;
  }

  await maybeValidatePendingEarlyEntry(currentCandle, now, strategy);
  await maybeOpenEarlyEntry(currentCandle, now, strategy);

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
    if (lastPendingTradeSkipOpenTime !== currentCandle.openTime) {
      logSkip(`${new Date(currentCandle.openTime).toISOString()} pending trade still open`);
      lastPendingTradeSkipOpenTime = currentCandle.openTime;
    }
    return;
  }

  const decision = strategy.getSignalForNextCandle();
  if (!decision.signal) {
    if (lastDecisionLogTargetOpenTime !== currentCandle.openTime) {
      logSkip(`${new Date(currentCandle.openTime).toISOString()} ${decision.reason}`);
    }
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
  await recoverPersistedPendingLiveTrade();

  while (!shuttingDown) {
    try {
      await tick();
    } catch (error) {
      logError(error);
      if (runOnce) {
        process.exitCode = 1;
        await drainGoogleSheetsQueue(5_000);
        closePolymarketChainlinkCandleSources();
        return;
      }
    }

    if (runOnce) {
      await drainGoogleSheetsQueue(5_000);
      closePolymarketChainlinkCandleSources();
      return;
    }

    await sleep(config.pollMs);
  }

  await cancelPendingLiveOrder();
  await drainGoogleSheetsQueue(5_000);
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
