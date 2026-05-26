import { AppConfig } from "../config/appConfig";
import { Candle, LiveOrder, PaperTrade, ResolvedPaperTrade, StrategySignal } from "../domain/types";

export function createPaperTrade(
  config: AppConfig,
  signal: StrategySignal,
  currentCandle: Candle,
  signalTime: number
): PaperTrade {
  const entryDecimal = config.entryCents / 100;
  const shares = config.stakeUsd / entryDecimal;
  const maxProfit = shares - config.stakeUsd;

  return {
    signalTime,
    candleOpenTime: currentCandle.openTime,
    candleCloseTime: currentCandle.closeTime,
    symbol: config.symbol,
    kind: signal.kind,
    direction: signal.direction,
    entryCents: config.entryCents,
    stakeUsd: config.stakeUsd,
    shares,
    maxProfit,
    open: currentCandle.open,
    reason: signal.reason,
  };
}

export function resolvePaperTrade(trade: PaperTrade, resolvedCandle: Candle): ResolvedPaperTrade {
  const won =
    (trade.direction === "UP" && resolvedCandle.close > resolvedCandle.open) ||
    (trade.direction === "DOWN" && resolvedCandle.close < resolvedCandle.open);
  const grossPnl = won ? trade.maxProfit : -trade.stakeUsd;

  return {
    ...trade,
    open: resolvedCandle.open,
    close: resolvedCandle.close,
    result: won ? "WIN" : "LOSS",
    pnl: grossPnl - (trade.feeUsd ?? 0),
  };
}

function resizeTradeToShares(trade: PaperTrade, shares: number, entryDecimal: number, feeUsd?: number): PaperTrade {
  const boundedShares = Math.max(shares, 0);
  const stakeUsd = boundedShares * entryDecimal;

  return {
    ...trade,
    entryCents: entryDecimal * 100,
    stakeUsd,
    shares: boundedShares,
    maxProfit: boundedShares - stakeUsd,
    feeUsd,
  };
}

export function resizeTradeToLiveFill(trade: PaperTrade, liveOrder: LiveOrder): PaperTrade {
  const filledShares = Math.min(Math.max(liveOrder.filledSize ?? 0, 0), liveOrder.size);
  const entryDecimal = liveOrder.price > 0 ? liveOrder.price : trade.entryCents / 100;
  return resizeTradeToShares(trade, filledShares, entryDecimal, liveOrder.feeUsd);
}

export function resizeTradeToUnfilledLiveRemainder(trade: PaperTrade, liveOrder: LiveOrder): PaperTrade {
  const filledShares = Math.min(Math.max(liveOrder.filledSize ?? 0, 0), liveOrder.size);
  const unfilledShares = Math.max(liveOrder.size - filledShares, 0);
  const entryDecimal = liveOrder.price > 0 ? liveOrder.price : trade.entryCents / 100;
  return resizeTradeToShares(trade, unfilledShares, entryDecimal);
}
