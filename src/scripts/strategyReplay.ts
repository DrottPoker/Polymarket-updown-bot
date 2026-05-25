import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { AppConfig } from "../config/appConfig";
import { Candle, CandleSettlement, Direction, StrategyDecision, StrategySignal, TradeKind } from "../domain/types";
import {
  getEarlyEntryStages,
  markDueEarlyEntryStagesAttempted,
  selectDueEarlyEntryStage,
} from "../trading/earlyEntryStages";
import { TradingViewReversalStrategy } from "../trading/strategy";

type CandleInput = {
  index: number;
  open: number;
  close: number;
  high?: number;
  low?: number;
  settlement?: CandleSettlement;
};

type ExpectedSignal = {
  kind: TradeKind;
  direction: Direction;
  reasonIncludes?: string;
};

type SignalExpectation = ExpectedSignal | null;

type BaseAction = {
  label?: string;
};

type ProcessClosedAction = BaseAction & {
  type: "processClosed";
  candle: CandleInput;
};

type RecordTradeAction = BaseAction & {
  type: "recordTrade";
  signal: ExpectedSignal & {
    reason?: string;
  };
  candle: CandleInput;
  result: "WIN" | "LOSS";
};

type ExpectSignalAction = BaseAction & {
  type: "expectSignal";
  previewCandles?: CandleInput[];
  expected: SignalExpectation;
};

type ExpectEarlySignalAction = BaseAction & {
  type: "expectEarlySignal";
  formingCandle: CandleInput;
  previewCandles?: CandleInput[];
  check?: {
    label?: string;
    minMovePct?: number | null;
  };
  expected: SignalExpectation;
};

type ExpectDueEarlyStageAction = BaseAction & {
  type: "expectDueEarlyStage";
  secondsLeft: number;
  attemptedStages?: string[];
  expectedStage: string | null;
  expectedAttemptedAfter?: string[];
};

type ReplayAction =
  | ProcessClosedAction
  | RecordTradeAction
  | ExpectSignalAction
  | ExpectEarlySignalAction
  | ExpectDueEarlyStageAction;

type ReplayFixture = {
  name: string;
  description?: string;
  config?: Partial<AppConfig>;
  seedCandles?: CandleInput[];
  actions: ReplayAction[];
};

type ReplayContext = {
  fixturePath: string;
  fixture: ReplayFixture;
  config: AppConfig;
  strategy: TradingViewReversalStrategy;
  processedCandles: Candle[];
};

const intervalMs = 300_000;

const defaultConfig: AppConfig = {
  priceSource: "polymarket_chainlink",
  symbol: "ETHUSDT",
  interval: "5m",
  entryCents: 50,
  tradeWindowSeconds: 300,
  stakeUsd: 3,
  evStakeUsd: 100,
  pollMs: 1000,
  candleLimit: 300,
  logFile: "trades.csv",
  statsFile: "stats.csv",
  localCsvLoggingEnabled: false,
  binanceBaseUrl: "https://api.binance.com",
  ignoreDojiInTrend: false,
  useLossRetryLogic: true,
  retryWaitCandles: 1,
  executionMode: "paper",
  liveTradingEnabled: false,
  liveConfirmation: "",
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  polymarketRtdsUrl: "wss://ws-live-data.polymarket.com",
  polymarketRtdsFirstPriceTimeoutMs: 15_000,
  polymarketHistoryBatchSize: 75,
  clobHost: "https://clob.polymarket.com",
  polygonRpcUrl: "https://polygon-rpc.com",
  polymarketAssetSlug: "eth",
  polymarketIntervalSlug: "5m",
  polymarketChainId: 137,
  polymarketPrivateKey: "",
  polymarketFunderAddress: "",
  polymarketSignatureType: 3,
  clobApiKey: "",
  clobSecret: "",
  clobPassphrase: "",
  maxEntryCents: 50,
  maxStakeUsd: 3,
  maxDailyLossUsd: 50,
  maxTradesPerDay: 50,
  maxLiveTradeWindowSeconds: 300,
  liveFullFillToleranceShares: 0.01,
  earlyEntryEnabled: true,
  earlyEntryPrimarySecondsBeforeClose: 15,
  earlyEntryPrimaryMinMovePct: 0.06,
  earlyEntrySecondarySecondsBeforeClose: 5,
  earlyEntrySecondaryMinMovePct: 0.03,
  earlyEntryOrderSecondsBeforeClose: 1,
  noTradeWindowEnabled: false,
  noTradeStart: "23:00",
  noTradeEnd: "07:00",
  noTradeTimeZone: "Europe/Stockholm",
  googleSheetsEnabled: false,
  googleSheetsSpreadsheetId: "",
  googleSheetsTradesSheetName: "Trades",
  googleSheetsStatsSheetName: "Stats",
  googleSheetsOrderEventsSheetName: "Order Events",
  googleServiceAccountEmail: "",
  googlePrivateKey: "",
};

class ReplayFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayFailure";
  }
}

function candleColor(open: number, close: number): Candle["color"] {
  if (close > open) {
    return "green";
  }

  if (close < open) {
    return "red";
  }

  return "doji";
}

function toCandle(input: CandleInput): Candle {
  const openTime = input.index * intervalMs;
  const high = input.high ?? Math.max(input.open, input.close);
  const low = input.low ?? Math.min(input.open, input.close);

  return {
    openTime,
    closeTime: openTime + intervalMs - 1,
    open: input.open,
    high,
    low,
    close: input.close,
    color: candleColor(input.open, input.close),
    settlement: input.settlement ?? "official",
  };
}

function signalSummary(signal: StrategySignal | null): string {
  if (!signal) {
    return "none";
  }

  return `${signal.kind} ${signal.direction} (${signal.reason})`;
}

function candleSummary(candle: Candle): string {
  return `#${candle.openTime / intervalMs} ${candle.color} open=${candle.open} close=${candle.close} ${
    candle.settlement ?? "official"
  }`;
}

function fail(context: ReplayContext, actionIndex: number, message: string, decision?: StrategyDecision): never {
  const recentCandles = context.processedCandles.slice(-8).map(candleSummary);
  const decisionText = decision ? `\nDecision: ${signalSummary(decision.signal)}\nReason: ${decision.reason}` : "";
  const candlesText = recentCandles.length > 0 ? `\nRecent processed candles:\n${recentCandles.join("\n")}` : "";
  throw new ReplayFailure(
    `${context.fixture.name} (${basename(context.fixturePath)}) action ${actionIndex + 1}: ${message}${decisionText}${candlesText}`
  );
}

function assertSignal(
  context: ReplayContext,
  actionIndex: number,
  decision: StrategyDecision,
  expected: SignalExpectation
): void {
  if (!expected) {
    if (decision.signal) {
      fail(context, actionIndex, `expected no signal, got ${signalSummary(decision.signal)}`, decision);
    }
    return;
  }

  if (!decision.signal) {
    fail(context, actionIndex, `expected ${expected.kind} ${expected.direction}, got no signal`, decision);
  }

  if (decision.signal.kind !== expected.kind || decision.signal.direction !== expected.direction) {
    fail(
      context,
      actionIndex,
      `expected ${expected.kind} ${expected.direction}, got ${signalSummary(decision.signal)}`,
      decision
    );
  }

  if (expected.reasonIncludes && !decision.signal.reason.includes(expected.reasonIncludes)) {
    fail(
      context,
      actionIndex,
      `expected reason to include "${expected.reasonIncludes}", got "${decision.signal.reason}"`,
      decision
    );
  }
}

function buildDecisionStrategy(context: ReplayContext, previewCandles: CandleInput[] | undefined): TradingViewReversalStrategy {
  const preview = (previewCandles ?? []).filter((candleInput) => (candleInput.settlement ?? "official") === "official");
  if (preview.length === 0) {
    return context.strategy;
  }

  const decisionStrategy = context.strategy.clone();
  for (const candleInput of preview) {
    decisionStrategy.processClosedCandleWithoutTrade(toCandle(candleInput));
  }

  return decisionStrategy;
}

function processClosed(context: ReplayContext, candleInput: CandleInput): void {
  const candle = toCandle(candleInput);
  context.strategy.processClosedCandleWithoutTrade(candle);
  context.processedCandles.push(candle);
}

function recordTrade(context: ReplayContext, action: RecordTradeAction): void {
  const candle = toCandle(action.candle);
  context.strategy.recordTradeResult(
    {
      signalTime: candle.openTime,
      candleOpenTime: candle.openTime,
      candleCloseTime: candle.closeTime,
      symbol: context.config.symbol,
      kind: action.signal.kind,
      direction: action.signal.direction,
      entryCents: context.config.entryCents,
      stakeUsd: context.config.stakeUsd,
      shares: context.config.stakeUsd / (context.config.entryCents / 100),
      maxProfit: context.config.stakeUsd / (context.config.entryCents / 100) - context.config.stakeUsd,
      open: candle.open,
      close: candle.close,
      reason: action.signal.reason ?? "fixture signal",
      result: action.result,
      pnl: action.result === "WIN" ? context.config.stakeUsd : -context.config.stakeUsd,
    },
    candle
  );
  context.processedCandles.push(candle);
}

function expectSignal(context: ReplayContext, actionIndex: number, action: ExpectSignalAction): void {
  const decisionStrategy = buildDecisionStrategy(context, action.previewCandles);
  const decision = decisionStrategy.getSignalForNextCandle();
  assertSignal(context, actionIndex, decision, action.expected);
}

function expectEarlySignal(context: ReplayContext, actionIndex: number, action: ExpectEarlySignalAction): void {
  const decisionStrategy = buildDecisionStrategy(context, action.previewCandles);
  const check = {
    label: action.check?.label ?? "fixture early entry",
    minMovePct: action.check?.minMovePct === undefined ? context.config.earlyEntryPrimaryMinMovePct : action.check.minMovePct,
  };
  const decision = decisionStrategy.getEarlySignalForNextCandle(toCandle(action.formingCandle), check);
  assertSignal(context, actionIndex, decision, action.expected);
}

function expectDueEarlyStage(context: ReplayContext, actionIndex: number, action: ExpectDueEarlyStageAction): void {
  const stages = getEarlyEntryStages(context.config);
  const attemptedStages = new Set(action.attemptedStages ?? []);
  const selected = selectDueEarlyEntryStage(stages, attemptedStages, action.secondsLeft);
  const selectedName = selected?.name ?? null;

  if (selectedName !== action.expectedStage) {
    fail(context, actionIndex, `expected due early stage ${action.expectedStage ?? "none"}, got ${selectedName ?? "none"}`);
  }

  if (selected) {
    markDueEarlyEntryStagesAttempted(stages, attemptedStages, selected);
  }

  if (action.expectedAttemptedAfter) {
    const actual = Array.from(attemptedStages).sort();
    const expected = [...action.expectedAttemptedAfter].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(context, actionIndex, `expected attempted stages ${expected.join(", ")}, got ${actual.join(", ")}`);
    }
  }
}

function runAction(context: ReplayContext, action: ReplayAction, actionIndex: number): void {
  switch (action.type) {
    case "processClosed":
      processClosed(context, action.candle);
      return;
    case "recordTrade":
      recordTrade(context, action);
      return;
    case "expectSignal":
      expectSignal(context, actionIndex, action);
      return;
    case "expectEarlySignal":
      expectEarlySignal(context, actionIndex, action);
      return;
    case "expectDueEarlyStage":
      expectDueEarlyStage(context, actionIndex, action);
      return;
  }
}

function parseFixture(path: string): ReplayFixture {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReplayFailure(`${path} must contain a fixture object`);
  }

  const fixture = parsed as ReplayFixture;
  if (!fixture.name || !Array.isArray(fixture.actions)) {
    throw new ReplayFailure(`${path} must include name and actions`);
  }

  return fixture;
}

function runFixture(path: string): void {
  const fixture = parseFixture(path);
  const config = {
    ...defaultConfig,
    ...(fixture.config ?? {}),
  };
  const context: ReplayContext = {
    fixturePath: path,
    fixture,
    config,
    strategy: new TradingViewReversalStrategy(config),
    processedCandles: [],
  };

  for (const candleInput of fixture.seedCandles ?? []) {
    processClosed(context, candleInput);
  }

  fixture.actions.forEach((action, index) => runAction(context, action, index));
}

function fixturePathsFromArgs(args: string[]): string[] {
  if (args.length > 0) {
    return args.map((arg) => resolve(arg));
  }

  const defaultDir = resolve("fixtures", "strategy");
  if (!existsSync(defaultDir)) {
    throw new ReplayFailure(`Default fixture directory does not exist: ${defaultDir}`);
  }

  return readdirSync(defaultDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => join(defaultDir, entry))
    .filter((path) => statSync(path).isFile())
    .sort();
}

function main(): void {
  const fixturePaths = fixturePathsFromArgs(process.argv.slice(2));
  let passed = 0;

  for (const fixturePath of fixturePaths) {
    runFixture(fixturePath);
    passed += 1;
    console.log(`[PASS] ${basename(fixturePath)}`);
  }

  console.log("");
  console.log(`[DONE] ${passed} strategy replay fixture(s) passed`);
}

try {
  main();
} catch (error) {
  console.error("");
  console.error("[FAIL]");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
