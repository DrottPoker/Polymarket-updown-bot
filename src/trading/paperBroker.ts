import { AppConfig } from "../config/appConfig";
import { Candle, PaperTrade, ResolvedPaperTrade, StrategySignal } from "../domain/types";

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
