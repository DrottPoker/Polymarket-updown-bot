# Architecture

This document describes the project architecture, runtime flow, module boundaries, and data ownership for the Polymarket Up/Down bot.

## System Goal

The bot runs a TradingView-style 3-candle reversal strategy against configurable crypto Up/Down markets. It can simulate trades in paper mode, preflight live orders in dry-run mode, or place real Polymarket CLOB limit orders in live mode.

The architecture is intentionally small and direct:

- Config is loaded once at startup.
- Market data is normalized into shared candle objects.
- Strategy state is owned by one strategy class.
- The main loop owns trade lifecycle decisions.
- Live order handling is isolated from strategy logic.
- Optional CSV logging is the only local persistence layer.

## Source Layout

```text
src/
  config/
    appConfig.ts
  domain/
    types.ts
  logging/
    googleSheetsLogger.ts
    logger.ts
  marketData/
    candles.ts
    polymarketChainlinkCandles.ts
  polymarket/
    marketDiscovery.ts
    liveExecutor.ts
  trading/
    strategy.ts
    paperBroker.ts
    riskManager.ts
  index.ts
```

## Module Responsibilities

### `src/index.ts`

The main runtime loop. It owns:

- Startup initialization.
- Strategy warmup.
- Startup-candle skipping.
- Poll scheduling.
- Pending trade state.
- Pending live order state.
- Early-entry timing.
- No-trade window checks.
- Trade resolution.
- Graceful shutdown.

The strategy decides whether a signal exists. `index.ts` decides whether that signal can become a paper trade, dry-run order, live order, or strategy-only hypothetical trade.

### `src/config/appConfig.ts`

Loads and validates runtime configuration.

- General bot options come from `bot.config.json`.
- Secrets and account-specific values come from `.env`.
- `BOT_EXECUTION_MODE` can override `executionMode` for npm scripts.
- `BOT_CONFIG_FILE` can point to a non-default config file.

This file is the only place that should parse config values or validate config shape.

### `src/domain/types.ts`

Shared domain types used across the codebase:

- Candles.
- Directions.
- Strategy signals.
- Paper trades.
- Resolved trades.
- Live order metadata.
- Execution mode and price source types.

### `src/marketData/candles.ts`

The candle source selector. It receives `AppConfig` and routes candle requests to:

- Polymarket/Chainlink candles when `priceSource` is `polymarket_chainlink`.
- Binance candles when `priceSource` is `binance`.

It returns normalized `Candle` objects regardless of source.

### `src/marketData/polymarketChainlinkCandles.ts`

Builds candle data aligned with Polymarket crypto Up/Down settlement.

It combines:

- Polymarket Gamma event metadata for resolved historical candles.
- Polymarket RTDS `crypto_prices_chainlink` WebSocket ticks for the current live candle.

It keeps a per-source in-memory cache, reconnects the WebSocket when needed, and closes socket resources on shutdown.

### `src/polymarket/marketDiscovery.ts`

Maps bot trade intent to Polymarket market metadata.

It builds the Up/Down event slug from:

- Asset slug.
- Interval slug.
- Candle open epoch.

Then it reads Gamma market metadata and resolves the correct token id for `UP` or `DOWN`.

### `src/polymarket/liveExecutor.ts`

Owns Polymarket live execution.

It handles:

- Public CLOB client setup.
- Market tradability checks.
- Order book metadata checks.
- Tick size handling.
- Minimum order size checks.
- CLOB credential derivation or configured credential usage.
- GTC limit BUY order creation.
- Cancel-on-window-end behavior.
- Fill detection after order placement and cancellation.

No strategy logic belongs here.

### `src/trading/strategy.ts`

Owns the TradingView-style strategy state machine.

It handles:

- Base 3-candle reversal signals.
- Doji trend handling.
- Retry-after-loss state.
- Hard reset mode when retry is disabled.
- Historical warmup simulation.
- Early-entry signal projection.
- Strategy counters used for internal behavior.

It does not know about Polymarket APIs, order books, wallets, CSV files, or PM2.

### `src/trading/paperBroker.ts`

Converts strategy signals into paper trades and resolves them after candle close.

It handles:

- Stake to shares calculation.
- Entry cents.
- PnL calculation.
- Win/loss evaluation from candle open and close.

Live trades use the same paper trade model for lifecycle and result tracking, with extra live order metadata attached by the logger.

### `src/trading/riskManager.ts`

Runtime risk guard for dry-run and live execution.

It checks:

- Max entry price.
- Max stake.
- Max trades per day.
- Max daily realized loss.

It tracks live order placements and resolved PnL in memory for the current process.

### `src/logging/logger.ts`

Owns all console and optional CSV output.

It handles:

- Startup logs.
- Warmup logs.
- Signal logs.
- Result logs.
- Live order logs.
- Live dry-run logs.
- Cancel logs.
- Skip logs.
- Error logs.
- Trade CSV creation and migration when local CSV logging is enabled.
- Stats CSV refresh when local CSV logging is enabled.

### `src/logging/googleSheetsLogger.ts`

Owns optional Google Sheets output.

It handles:

- Service account JWT authentication.
- Google Sheets API token refresh.
- Trades and stats tab creation.
- Header creation.
- Trade row appends.
- Stats tab replacement from Google Sheets `Trades` tab data.
- Google Sheets log clearing for remote restart.

Google Sheets is treated as a separate remote log. Its stats are derived only from rows in the Google Sheets `Trades` tab.

## Runtime Flow

```text
start process
load config
create strategy
create risk manager
create live executor if needed
ensure local CSV logs if enabled
refresh local stats CSV if enabled
poll candles
warm up strategy from closed candles
skip the candle already in progress at startup
repeat poll loop
```

Each poll follows this high-level flow:

```text
fetch normalized candles
process newly closed candles
resolve pending trades
cancel live orders if due
check early entry stages
check normal candle-open signal
apply no-trade window
apply risk checks
open paper trade, dry-run order, or live order
sleep pollMs
```

## Trade Lifecycle

### Paper Mode

1. Strategy emits a signal.
2. `paperBroker` creates a paper trade.
3. The bot waits until the trade candle closes.
4. `paperBroker` resolves the result.
5. The configured loggers append the trade row and refresh stats.
6. Strategy records the result and updates retry/reset state.

### Live Dry-Run Mode

1. Strategy emits a signal.
2. Risk checks run.
3. Polymarket market discovery runs.
4. Order book metadata is checked.
5. The exact order payload is logged.
6. No real order is posted.
7. The trade is resolved like a simulated trade after candle close.

### Live Mode

1. Strategy emits a signal.
2. Risk checks run.
3. Polymarket market discovery runs.
4. Order book metadata is checked.
5. A GTC limit BUY order is posted.
6. The bot tracks the order until fill, cancel time, or candle resolution.
7. If the order is fully filled according to authenticated successful CLOB trade records, the resolved trade is logged to the configured log targets.
8. If the order is not fully filled, the strategy state still updates hypothetically, but no real trade row is created.

## Early Entry Flow

Early entry targets the next contract while the current candle is still forming.

The main loop checks stages in this order:

1. Primary stage at `earlyEntryPrimarySecondsBeforeClose`.
2. Secondary stage at `earlyEntrySecondarySecondsBeforeClose`.
3. Final stage at `earlyEntryOrderSecondsBeforeClose`.

Primary and secondary stages require a minimum move percentage. The final stage only requires that the forming candle has the correct color for the setup.

When one stage successfully opens a trade for the next candle, later stages for that same target candle are marked as done.

If a pending trade was opened by the primary or secondary stage, the final stage still runs as a validation pass. The bot re-evaluates the forming candle with color-only requirements. If the signal no longer matches the pending trade kind and direction, the pending order is canceled when possible and the pending trade is cleared.

## No-Trade Window Flow

The no-trade window blocks new entries by target candle open time.

If a signal appears during the blocked window:

- No paper/live order is opened.
- The signal is tracked as a strategy-only hypothetical trade.
- The strategy still receives the hypothetical result after candle close.
- No real trade row is written to the configured trade log.

This keeps retry state consistent without placing unwanted trades.

## Data Boundaries

### Config Files

`bot.config.json` is local and ignored by Git. It contains normal bot settings.

`.env` is local and ignored by Git. It contains secrets and private/account-specific values only.

### Runtime Files

`trades.csv` contains resolved real or paper trades when `localCsvLoggingEnabled` is `true`.

`stats.csv` contains aggregate statistics generated from `trades.csv` when `localCsvLoggingEnabled` is `true`.

When Google Sheets is enabled and `localCsvLoggingEnabled` is `false`, resolved trades are written only to the configured Google Sheets `Trades` tab and stats are derived only from that tab.

Both files are runtime output and should not be edited by code changes unless the task is specifically about local log repair.

### Build Output

`dist/` is generated by TypeScript. It is ignored by Git and should not be edited manually.

`npm run build` cleans `dist/` before compiling so stale generated files do not remain after source files are moved.

## External Systems

The bot can interact with:

- Polymarket Gamma API for market and event metadata.
- Polymarket RTDS WebSocket for Chainlink live prices.
- Polymarket CLOB API for order books, order placement, fills, and cancels.
- Polygon RPC for signer-backed CLOB authentication.
- Binance REST API when using Binance comparison candles.
- Google Sheets API when spreadsheet logging is enabled.

## Deployment Shape

The intended production deployment is:

```text
Linux VPS
Node.js LTS
npm dependencies
PM2 process manager
local bot.config.json
local .env
optional CSV files on local disk
optional Google spreadsheet log
```

PM2 keeps the process running after SSH disconnects and can restore it after reboot.

## Safety Model

Live execution requires multiple independent guards:

- `executionMode` must be `live`.
- `liveTradingEnabled` must be `true`.
- `liveConfirmation` must equal `PLACE_REAL_POLYMARKET_ORDERS`.
- Private key and funder address must be present.
- RPC URL must be valid.
- Trade window must not exceed the live max window.
- Entry, stake, daily loss, and trade count limits must pass.

These checks are intentionally redundant because live mode can place real orders.
