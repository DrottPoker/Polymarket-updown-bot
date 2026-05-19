import { AppConfig } from "./config";
import { Candle, Direction, ResolvedPaperTrade, StrategyDecision, StrategySignal, TradeKind, TrendColor } from "./types";

type StrategyStats = {
  totalSignals: number;
  totalWins: number;
  totalLosses: number;
  upSignals: number;
  downSignals: number;
  upWins: number;
  downWins: number;
  baseSignals: number;
  baseWins: number;
  baseLosses: number;
  retrySignals: number;
  retryWins: number;
  retryLosses: number;
  totalWaitCandles: number;
  trendContinuedAfterLoss: number;
  trendBrokeAfterLoss: number;
  instantRetrySetups: number;
  blockedCandles: number;
  resetEvents: number;
  dojiTradeLosses: number;
};

const emptyStats = (): StrategyStats => ({
  totalSignals: 0,
  totalWins: 0,
  totalLosses: 0,
  upSignals: 0,
  downSignals: 0,
  upWins: 0,
  downWins: 0,
  baseSignals: 0,
  baseWins: 0,
  baseLosses: 0,
  retrySignals: 0,
  retryWins: 0,
  retryLosses: 0,
  totalWaitCandles: 0,
  trendContinuedAfterLoss: 0,
  trendBrokeAfterLoss: 0,
  instantRetrySetups: 0,
  blockedCandles: 0,
  resetEvents: 0,
  dojiTradeLosses: 0,
});

function rawColor(candle: Candle): TrendColor {
  return candle.color;
}

function directionForTrendContinuation(trendColor: TrendColor): Direction | null {
  if (trendColor === "red") {
    return "UP";
  }

  if (trendColor === "green") {
    return "DOWN";
  }

  return null;
}

function tradeWon(direction: Direction, candle: Candle): boolean {
  return (direction === "UP" && candle.close > candle.open) || (direction === "DOWN" && candle.close < candle.open);
}

export class TradingViewReversalStrategy {
  private readonly candles: Candle[] = [];
  private readonly stats = emptyStats();
  private barIndex = -1;
  private waitingForRetry = false;
  private retryReady = false;
  private retryTrendColor: TrendColor | null = null;
  private waitedCandles = 0;
  private blockedAfterLoss = false;
  private blockedTrendColor: TrendColor | null = null;
  private resetBarIndex: number | null = null;

  constructor(private readonly config: AppConfig) {}

  warmUp(closedCandles: Candle[]): void {
    for (const candle of closedCandles) {
      this.processHistoricalClosedCandle(candle);
    }
  }

  getStats(): StrategyStats {
    return { ...this.stats };
  }

  getSignalForNextCandle(): StrategyDecision {
    return this.evaluateSignal(false);
  }

  getEarlySignalForNextCandle(formingCandle: Candle): StrategyDecision {
    const retryDecision = this.getEarlyRetrySignalForNextCandle(formingCandle);
    if (retryDecision.signal) {
      return retryDecision;
    }

    if (this.waitingForRetry) {
      return retryDecision;
    }

    return this.getEarlyBaseSignalForNextCandle(formingCandle);
  }

  private getEarlyRetrySignalForNextCandle(formingCandle: Candle): StrategyDecision {
    if (!this.config.useLossRetryLogic) {
      return {
        signal: null,
        reason: "retry logic is disabled",
      };
    }

    if (this.retryReady) {
      return {
        signal: null,
        reason: "retry is already ready for the current candle",
      };
    }

    if (!this.waitingForRetry) {
      return {
        signal: null,
        reason: "not waiting for retry",
      };
    }

    if (!this.retryTrendColor) {
      return {
        signal: null,
        reason: "waiting for retry but retry trend color is missing",
      };
    }

    const qualifiedTrend = this.getQualifiedFormingTrendColor(formingCandle);
    if (!qualifiedTrend.trendColor) {
      return {
        signal: null,
        reason: qualifiedTrend.reason,
      };
    }

    if (qualifiedTrend.trendColor !== this.retryTrendColor) {
      return {
        signal: null,
        reason: `early retry trend is ${qualifiedTrend.trendColor}, expected ${this.retryTrendColor}`,
      };
    }

    const projectedWaitedCandles = this.waitedCandles + 1;
    if (projectedWaitedCandles < this.config.retryWaitCandles) {
      return {
        signal: null,
        reason: `early retry wait progress ${projectedWaitedCandles}/${this.config.retryWaitCandles}`,
      };
    }

    const direction = directionForTrendContinuation(this.retryTrendColor);
    if (!direction) {
      return {
        signal: null,
        reason: "retry trend color has no direction",
      };
    }

    return {
      signal: {
        direction,
        kind: "RETRY",
        reason: `early retry setup; forming candle continued ${this.retryTrendColor} trend (${qualifiedTrend.movePct.toFixed(4)}%)`,
      },
      reason: "early retry signal",
    };
  }

  private getEarlyBaseSignalForNextCandle(formingCandle: Candle): StrategyDecision {
    const baseBlockReason = this.getBaseBlockReason();
    if (baseBlockReason) {
      return {
        signal: null,
        reason: baseBlockReason,
      };
    }

    const qualifiedTrend = this.getQualifiedFormingTrendColor(formingCandle);
    if (!qualifiedTrend.trendColor) {
      return {
        signal: null,
        reason: qualifiedTrend.reason,
      };
    }

    const currentTrendColor = qualifiedTrend.trendColor;
    const previousTrendColors = this.getLastTrendColorsBeforeCurrent(2);
    if (previousTrendColors.length < 2) {
      return {
        signal: null,
        reason: "not enough previous trend candles for early-entry setup",
      };
    }

    const isThirdGreen = currentTrendColor === "green" && previousTrendColors.every((color) => color === "green");
    const isThirdRed = currentTrendColor === "red" && previousTrendColors.every((color) => color === "red");

    if (isThirdGreen) {
      return {
        signal: {
          direction: "DOWN",
          kind: "BASE",
          reason: `early base setup; forming candle is third green trend candle (${qualifiedTrend.movePct.toFixed(4)}%)`,
        },
        reason: "early base signal",
      };
    }

    if (isThirdRed) {
      return {
        signal: {
          direction: "UP",
          kind: "BASE",
          reason: `early base setup; forming candle is third red trend candle (${qualifiedTrend.movePct.toFixed(4)}%)`,
        },
        reason: "early base signal",
      };
    }

    return {
      signal: null,
      reason: `early-entry trend chain was ${currentTrendColor}, ${previousTrendColors.join(", ")}`,
    };
  }

  private getQualifiedFormingTrendColor(formingCandle: Candle): {
    trendColor: Exclude<TrendColor, "doji"> | null;
    movePct: number;
    reason: string;
  } {
    const previousClosedCandle = this.candles[this.candles.length - 1];
    if (!previousClosedCandle) {
      return {
        trendColor: null,
        movePct: 0,
        reason: "not enough candles for early-entry setup",
      };
    }

    const movePct = ((formingCandle.close - previousClosedCandle.close) / previousClosedCandle.close) * 100;
    const rawCurrentColor = rawColor(formingCandle);

    if (rawCurrentColor === "green" && movePct >= this.config.earlyEntryMinMovePct) {
      return {
        trendColor: "green",
        movePct,
        reason: "qualified green forming candle",
      };
    }

    if (rawCurrentColor === "red" && movePct <= -this.config.earlyEntryMinMovePct) {
      return {
        trendColor: "red",
        movePct,
        reason: "qualified red forming candle",
      };
    }

    return {
      trendColor: null,
      movePct,
      reason: `early-entry move ${movePct.toFixed(4)}% has not reached +/-${this.config.earlyEntryMinMovePct}%`,
    };
  }

  processClosedCandleWithoutTrade(candle: Candle): void {
    this.preProcessClosedCandle(candle);
    this.addProcessedCandle(candle);
  }

  recordTradeResult(trade: ResolvedPaperTrade, closedCandle: Candle): void {
    this.applyTradeOutcome(
      {
        direction: trade.direction,
        kind: trade.kind,
        reason: trade.reason,
      },
      closedCandle,
      trade.result
    );
    this.addProcessedCandle(closedCandle);
  }

  private processHistoricalClosedCandle(candle: Candle): void {
    const skipTradeThisBar = this.preProcessClosedCandle(candle);
    const decision = this.evaluateSignal(skipTradeThisBar);

    if (decision.signal) {
      this.applyTradeOutcome(decision.signal, candle, tradeWon(decision.signal.direction, candle) ? "WIN" : "LOSS");
    }

    this.addProcessedCandle(candle);
  }

  private addProcessedCandle(candle: Candle): void {
    this.candles.push(candle);
    this.barIndex += 1;

    if (this.candles.length > this.config.candleLimit) {
      this.candles.shift();
    }
  }

  private preProcessClosedCandle(candle: Candle): boolean {
    let skipTradeThisBar = false;
    const currentTrendColor = this.getTrendColor(candle, this.candles);
    const currentBarIndex = this.barIndex + 1;

    if (this.config.useLossRetryLogic && this.waitingForRetry) {
      if (currentTrendColor === "doji") {
        skipTradeThisBar = true;
      } else {
        this.stats.totalWaitCandles += 1;
        this.waitedCandles += 1;
        skipTradeThisBar = true;

        if (currentTrendColor === this.retryTrendColor) {
          this.stats.trendContinuedAfterLoss += 1;

          if (this.waitedCandles >= this.config.retryWaitCandles) {
            this.waitingForRetry = false;
            this.retryReady = true;
            this.waitedCandles = 0;
          }
        } else {
          this.stats.trendBrokeAfterLoss += 1;
          this.waitingForRetry = false;
          this.retryReady = false;
          this.retryTrendColor = null;
          this.waitedCandles = 0;
        }
      }
    }

    if (!this.config.useLossRetryLogic && this.blockedAfterLoss) {
      if (currentTrendColor === "doji") {
        skipTradeThisBar = true;
      } else if (currentTrendColor === this.blockedTrendColor) {
        this.stats.blockedCandles += 1;
        skipTradeThisBar = true;
      } else {
        this.stats.resetEvents += 1;
        this.blockedAfterLoss = false;
        this.blockedTrendColor = null;
        this.resetBarIndex = currentBarIndex;
        skipTradeThisBar = true;
      }
    }

    return skipTradeThisBar;
  }

  private evaluateSignal(skipTradeThisBar: boolean): StrategyDecision {
    if (skipTradeThisBar) {
      return {
        signal: null,
        reason: "state changed on this candle; Pine logic skips trading this bar",
      };
    }

    if (this.config.useLossRetryLogic && this.retryReady) {
      const retryDirection = this.retryTrendColor ? directionForTrendContinuation(this.retryTrendColor) : null;
      if (!retryDirection) {
        return {
          signal: null,
          reason: "retry is ready but has no usable trend color",
        };
      }

      return {
        signal: {
          direction: retryDirection,
          kind: "RETRY",
          reason: `retry after loss; trend continued ${this.retryTrendColor}`,
        },
        reason: "retry signal",
      };
    }

    if (this.waitingForRetry) {
      const baseBlockReason = this.getBaseBlockReason();
      return {
        signal: null,
        reason: baseBlockReason ?? "waiting for retry confirmation candles after loss",
      };
    }

    const baseBlockReason = this.getBaseBlockReason();
    if (baseBlockReason) {
      return {
        signal: null,
        reason: baseBlockReason,
      };
    }

    const last3TrendColors = this.getLastTrendColorsBeforeCurrent(3);
    if (last3TrendColors.length < 3) {
      return {
        signal: null,
        reason: "not enough trend candles for setup",
      };
    }

    const [nd1, nd2, nd3] = last3TrendColors;
    const threeGreen = nd1 === "green" && nd2 === "green" && nd3 === "green";
    const threeRed = nd1 === "red" && nd2 === "red" && nd3 === "red";

    if (threeGreen) {
      return {
        signal: {
          direction: "DOWN",
          kind: "BASE",
          reason: "base setup; previous 3 trend candles were green",
        },
        reason: "base signal",
      };
    }

    if (threeRed) {
      return {
        signal: {
          direction: "UP",
          kind: "BASE",
          reason: "base setup; previous 3 trend candles were red",
        },
        reason: "base signal",
      };
    }

    return {
      signal: null,
      reason: `last 3 trend candles were ${last3TrendColors.join(", ")}`,
    };
  }

  private hasFreshCandlesAfterReset(): boolean {
    return this.resetBarIndex === null || this.barIndex + 1 - 3 > this.resetBarIndex;
  }

  private getBaseBlockReason(): string | null {
    if (this.config.useLossRetryLogic && this.retryReady) {
      return "retry is ready; base setup is blocked";
    }

    if (this.waitingForRetry) {
      return "waiting for retry confirmation candles after loss";
    }

    if (this.blockedAfterLoss) {
      return `blocked after loss while ${this.blockedTrendColor} trend continues`;
    }

    if (!this.config.useLossRetryLogic && !this.hasFreshCandlesAfterReset()) {
      return "waiting for 3 fresh candles after post-loss trend break";
    }

    return null;
  }

  private getLastTrendColorsBeforeCurrent(count: number): TrendColor[] {
    const colors: TrendColor[] = [];

    for (let offset = 1; offset <= 100 && colors.length < count; offset += 1) {
      const candleIndex = this.candles.length - offset;
      if (candleIndex < 0) {
        break;
      }

      const candle = this.candles[candleIndex];
      const historyBeforeCandle = this.candles.slice(0, candleIndex);
      const trendColor = this.getTrendColor(candle, historyBeforeCandle);
      if (trendColor !== "doji") {
        colors.push(trendColor);
      }
    }

    return colors;
  }

  private getTrendColor(candle: Candle, previousCandles: Candle[]): TrendColor {
    const color = rawColor(candle);
    if (color !== "doji") {
      return color;
    }

    if (this.config.ignoreDojiInTrend) {
      return "doji";
    }

    for (let offset = 1; offset <= 100; offset += 1) {
      const older = previousCandles[previousCandles.length - offset];
      if (!older) {
        break;
      }

      const olderColor = rawColor(older);
      if (olderColor !== "doji") {
        return olderColor;
      }
    }

    return "doji";
  }

  private applyTradeOutcome(signal: StrategySignal, candle: Candle, result: "WIN" | "LOSS"): void {
    this.stats.totalSignals += 1;

    if (signal.kind === "BASE") {
      this.stats.baseSignals += 1;
    } else {
      this.stats.retrySignals += 1;
    }

    if (signal.direction === "UP") {
      this.stats.upSignals += 1;
    } else {
      this.stats.downSignals += 1;
    }

    if (result === "WIN") {
      this.stats.totalWins += 1;

      if (signal.kind === "BASE") {
        this.stats.baseWins += 1;
      } else {
        this.stats.retryWins += 1;
      }

      if (signal.direction === "UP") {
        this.stats.upWins += 1;
      } else {
        this.stats.downWins += 1;
      }

      this.resetSpecialStatesAfterWin();
      return;
    }

    this.stats.totalLosses += 1;

    if (candle.color === "doji") {
      this.stats.dojiTradeLosses += 1;
    }

    if (signal.kind === "BASE") {
      this.stats.baseLosses += 1;
    } else {
      this.stats.retryLosses += 1;
    }

    const lossTrendColor: TrendColor = signal.direction === "DOWN" ? "green" : "red";
    this.applyLossState(lossTrendColor);
  }

  private resetSpecialStatesAfterWin(): void {
    this.waitingForRetry = false;
    this.retryReady = false;
    this.retryTrendColor = null;
    this.waitedCandles = 0;
    this.blockedAfterLoss = false;
    this.blockedTrendColor = null;
  }

  private applyLossState(lossTrendColor: TrendColor): void {
    if (this.config.useLossRetryLogic) {
      this.retryTrendColor = lossTrendColor;
      this.blockedAfterLoss = false;
      this.blockedTrendColor = null;

      if (this.config.retryWaitCandles === 0) {
        this.stats.instantRetrySetups += 1;
        this.waitingForRetry = false;
        this.retryReady = true;
        this.waitedCandles = 0;
      } else {
        this.waitingForRetry = true;
        this.retryReady = false;
        this.waitedCandles = 0;
      }

      return;
    }

    this.waitingForRetry = false;
    this.retryReady = false;
    this.retryTrendColor = null;
    this.waitedCandles = 0;
    this.blockedAfterLoss = true;
    this.blockedTrendColor = lossTrendColor;
  }
}
