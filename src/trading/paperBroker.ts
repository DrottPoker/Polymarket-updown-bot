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

  return {
    ...trade,
    open: resolvedCandle.open,
    close: resolvedCandle.close,
    result: won ? "WIN" : "LOSS",
    pnl: won ? trade.maxProfit : -trade.stakeUsd,
  };
}

export function resizeTradeToLiveFill(trade: PaperTrade, liveOrder: LiveOrder): PaperTrade {
  const filledShares = Math.min(Math.max(liveOrder.filledSize ?? 0, 0), liveOrder.size);
  const entryDecimal = liveOrder.price > 0 ? liveOrder.price : trade.entryCents / 100;
  const stakeUsd = filledShares * entryDecimal;

  return {
    ...trade,
    entryCents: entryDecimal * 100,
    stakeUsd,
    shares: filledShares,
    maxProfit: filledShares - stakeUsd,
  };
}
