import { AppConfig } from "../config/appConfig";
import { PaperTrade, ResolvedPaperTrade } from "../domain/types";

export type RuntimeRiskSnapshot = {
  currentDay: string;
  tradesToday: number;
  realizedPnlToday: number;
};

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class RuntimeRiskManager {
  private currentDay = dayKey(Date.now());
  private tradesToday = 0;
  private realizedPnlToday = 0;

  constructor(private readonly config: AppConfig, snapshot?: RuntimeRiskSnapshot) {
    if (snapshot) {
      this.currentDay = snapshot.currentDay;
      this.tradesToday = snapshot.tradesToday;
      this.realizedPnlToday = snapshot.realizedPnlToday;
      this.rollDay(Date.now());
    }
  }

  getSnapshot(): RuntimeRiskSnapshot {
    this.rollDay(Date.now());
    return {
      currentDay: this.currentDay,
      tradesToday: this.tradesToday,
      realizedPnlToday: this.realizedPnlToday,
    };
  }

  assertCanOpen(trade: PaperTrade): void {
    this.rollDay(trade.signalTime);

    if (trade.entryCents > this.config.maxEntryCents) {
      throw new Error(`Risk blocked trade: entry ${trade.entryCents}c exceeds max ${this.config.maxEntryCents}c`);
    }

    if (trade.stakeUsd > this.config.maxStakeUsd) {
      throw new Error(`Risk blocked trade: stake $${trade.stakeUsd} exceeds max $${this.config.maxStakeUsd}`);
    }

    if (this.tradesToday >= this.config.maxTradesPerDay) {
      throw new Error(`Risk blocked trade: max trades per day reached (${this.config.maxTradesPerDay})`);
    }

    if (this.realizedPnlToday <= -this.config.maxDailyLossUsd) {
      throw new Error(`Risk blocked trade: daily loss limit reached ($${this.realizedPnlToday.toFixed(2)})`);
    }
  }

  recordOrderPlaced(timestamp: number): void {
    this.rollDay(timestamp);
    this.tradesToday += 1;
  }

  recordResolvedTrade(trade: ResolvedPaperTrade): void {
    this.rollDay(trade.candleCloseTime);
    this.realizedPnlToday += trade.pnl;
  }

  private rollDay(timestamp: number): void {
    const nextDay = dayKey(timestamp);
    if (nextDay !== this.currentDay) {
      this.currentDay = nextDay;
      this.tradesToday = 0;
      this.realizedPnlToday = 0;
    }
  }
}
