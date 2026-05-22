export type CandleColor = "green" | "red" | "doji";

export type Direction = "UP" | "DOWN";

export type TradeResult = "WIN" | "LOSS";

export type TrendColor = "green" | "red" | "doji";

export type TradeKind = "BASE" | "RETRY";

export type ExecutionMode = "paper" | "live_dry_run" | "live";

export type PriceSource = "binance" | "polymarket_chainlink";

export type Candle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  color: CandleColor;
};

export type StrategySignal = {
  direction: Direction;
  kind: TradeKind;
  reason: string;
};

export type StrategyDecision = {
  signal: StrategySignal | null;
  reason: string;
};

export type PaperTrade = {
  signalTime: number;
  candleOpenTime: number;
  candleCloseTime: number;
  symbol: string;
  kind: TradeKind;
  direction: Direction;
  entryCents: number;
  stakeUsd: number;
  shares: number;
  maxProfit: number;
  open: number;
  reason: string;
};

export type ResolvedPaperTrade = PaperTrade & {
  close: number;
  result: TradeResult;
  pnl: number;
};

export type PolymarketOutcome = "Up" | "Down";

export type PolymarketMarketSelection = {
  slug: string;
  title: string;
  conditionId: string;
  tokenId: string;
  outcome: PolymarketOutcome;
  active: boolean;
  closed: boolean;
  enableOrderBook: boolean;
};

export type LiveOrder = {
  dryRun: boolean;
  marketSlug: string;
  conditionId: string;
  tokenId: string;
  outcome: PolymarketOutcome;
  price: number;
  size: number;
  tickSize: string;
  minOrderSize: string;
  negRisk: boolean;
  orderId?: string;
  status?: string;
  postedAt: number;
  cancelAt: number;
  response: unknown;
  filled: boolean;
  canceled: boolean;
  cancelResponse?: unknown;
};
