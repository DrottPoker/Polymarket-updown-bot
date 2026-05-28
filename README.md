# Polymarket Up/Down Bot

Node.js/TypeScript trading bot for an ETH/USDT configurable-interval 3-candle reversal strategy intended for Polymarket Up/Down markets.

By default this runs in paper mode. It fetches Polymarket/Chainlink reference candles for current crypto Up/Down markets, detects TradingView-style base/retry signals, simulates entry at the configured cents price, resolves after the candle closes, and writes results to CSV.

Live Polymarket execution is available behind explicit config guards. Do not enable it until paper behavior, funding, allowances, and risk limits are verified.

## Setup

```bash
npm install
cp bot.config.example.json bot.config.json
cp .env.example .env
npm run dev
```

For a single startup/poll verification run:

```bash
npm run dev:once
```

For a live dry-run preflight without posting orders:

```bash
npm run dry-run:once
```

## Config

General bot options live in `bot.config.json`. Copy `bot.config.example.json` once, then edit the local file. It is ignored by Git so VPS-specific settings do not conflict with future pulls.

Secrets and account-specific values live in `.env`:

```env
POLYGON_RPC_URL=https://polygon-rpc.com
POLYMARKET_FUNDER_ADDRESS=
POLYMARKET_PRIVATE_KEY=
CLOB_API_KEY=
CLOB_SECRET=
CLOB_PASS_PHRASE=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
```

Runtime scripts can temporarily override the configured execution mode. Do not put non-secret bot settings in `.env`.

## Project Structure

```text
src/
  config/       Config loading and validation
  domain/       Shared domain types
  logging/      Console, optional CSV, and Google Sheets output
  marketData/   Binance and Polymarket/Chainlink candle sources
  polymarket/   Gamma market discovery and CLOB live execution
  scripts/      Operational and replay scripts
  trading/      Strategy, simulated trades, and runtime risk checks
  index.ts      Main polling loop and trade lifecycle
fixtures/
  strategy/     Deterministic replay fixtures for strategy timing
```

## Documentation

- [Overview](docs/OVERVIEW.md)
- [Features](docs/FEATURES.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Operations](docs/OPERATIONS.md)

## Price Source

`priceSource: "polymarket_chainlink"` makes the bot use the same reference family as current Polymarket crypto Up/Down markets:

- Historical warmup and closed trade settlement candles come from Polymarket Gamma event metadata: `priceToBeat` as open and `finalPrice`, or the next event `priceToBeat`, as close.
- If Gamma has resolved a market outcome but has not published a numeric final price, the bot uses that official `Up` or `Down` outcome to build a directional fallback candle.
- Closed candles used for trend history prefer official Polymarket/Gamma candles. If the newest closed candle is not official yet but RTDS has the open and close, the bot can use that provisional closed candle so entries do not stall.
- Live/current candles are aggregated from Polymarket RTDS `crypto_prices_chainlink` WebSocket updates.
- Warmup uses the latest contiguous closed candles available. If older Gamma metadata has a gap, startup continues with the newer contiguous history instead of blocking on that old candle.
- If the bot starts after a candle is already open, the live candle open is corrected from Polymarket Gamma `priceToBeat` or the previous official close when available instead of using the first live tick seen by the bot.

Use `priceSource: "binance"` only for comparison/backtesting against Binance candles. Binance can disagree with Polymarket settlement for current Chainlink-resolved markets.

When using `polymarket_chainlink`, `polymarketAssetSlug` selects the Chainlink symbol (`eth` -> `eth/usd`). `symbol` remains as the CSV label and Binance fallback symbol.

## Strategy

- Base signal: last 3 trend candles red means bet `UP`; last 3 trend candles green means bet `DOWN`.
- Doji trend handling follows `ignoreDojiInTrend`. When false, doji candles inherit the previous non-doji trend color.
- Active trade doji results count as `LOSS`, matching the TradingView script.
- When `useLossRetryLogic=true`, a loss can arm retry mode after `retryWaitCandles`.
- When retry logic is off, a loss blocks same-trend continuation until the trend breaks and 3 fresh candles have formed.
- The bot warms up strategy state from `candleLimit` candles at startup.
- Optional early entry can place the next contract order before candle close when the forming candle is already the third trend candle.
- If a provisional closed candle is later replaced by official Gamma metadata, the stored candle is corrected and logged with `[CANDLE_CORRECTION]`.
- The startup candle is skipped for direct entry on that candle, but early entry for the next candle remains enabled. When it closes, it is logged with its open, close, color, and source.

## Spreadsheet Logs

Local CSV logging is controlled by `localCsvLoggingEnabled`. When it is `true`, the bot writes every resolved trade to `logFile` as a spreadsheet-friendly CSV. New live trades include Polymarket metadata such as market slug, token id, order id, live status, fill status, live price, and live size.

When local CSV logging is enabled, the bot rewrites `statsFile` after each resolved trade with aggregate statistics for `TOTAL`, `BASE`, `RETRY`, `UP`, `DOWN`, `BASE_UP`, `BASE_DOWN`, `RETRY_UP`, and `RETRY_DOWN`.

The local `orderEventsFile` records live order placement, fill, cancellation, and not-filled events. Those files can be opened directly in Excel or imported into Google Sheets.

Live mode requires `localCsvLoggingEnabled=true` so the bot has durable local audit logs even if Google Sheets is slow or unavailable. Runtime recovery state is written to `runtimeStateFile`.

## Google Sheets Logging

The bot can also write resolved trades and aggregate stats to an existing Google spreadsheet.

Enable it in `bot.config.json`:

```json
{
  "localCsvLoggingEnabled": false,
  "googleSheetsEnabled": true,
  "googleSheetsSpreadsheetId": "your-spreadsheet-id",
  "googleSheetsTradesSheetName": "Trades",
  "googleSheetsStatsSheetName": "Stats",
  "googleSheetsOrderEventsSheetName": "Order Events",
  "googleSheetsCandlesSheetName": "Candles",
  "googleSheetsRequestTimeoutMs": 10000
}
```

Use a Google service account and share the spreadsheet with the service account email as an editor. Store the service account credentials in `.env`:

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Google Sheets stats are calculated from realized rows in the configured `Trades` tab. Paper rows with no `order_id` are counted. Live rows are counted only when `live_filled` is `TRUE`. Partially filled live orders are logged with `live_status=partial`, `live_filled=TRUE`, and a proportional stake, share size, and PnL. Live CLOB taker fees are deducted from `pnl` and written to the trailing `fee_usd` column so balances use net realized PnL. Order placement, fill, final-check cancel, and unfilled-order events are written to the configured `Order Events` tab so they can be analyzed without being counted as filled trades. `ORDER_NOT_FILLED` rows include `missed_result`, `missed_pnl`, and `missed_close` when the candle result is known. For partial fills, `missed_pnl` is sized only to the unfilled remainder. Closed Polymarket ETH candles are upserted into the configured `Candles` tab with open, high, low, close, source, result, and market slug so future backtests can use raw market outcomes. Google Sheets errors are logged, but they do not stop the bot from managing trades.

Google Sheets writes are queued outside the order-management path and each HTTP request is bounded by `googleSheetsRequestTimeoutMs`. Live order placement and cancellation do not wait on Sheets after the local audit log has been written. When local CSV logging is enabled, the bot reconciles local `trades.csv` and `order-events.csv` into Google Sheets at startup and after a failed Sheets write, appending rows that are missing by order or event key and then refreshing stats. Startup reconciliation does not bulk import old local CSV rows when both raw Google Sheets tabs are empty.

For live trades, `live_status` is the initial Polymarket order status. `live` means the order was accepted and open at first. `matched` means the post response matched against liquidity immediately. `partial` means the order did not fully fill before cancel, but a non-zero filled portion was logged proportionally as a realized trade. Realized performance should use `live_filled`, not `live_status`.

To clear the Google Sheets trade log and restart the dashboard from zero:

```bash
npm run sheets:clear
```

This clears only the configured raw log tabs: `Trades` back to A:W headers, `Order Events` back to A:AA headers, and `Stats` rebuilt from the now-empty `Trades` tab. It preserves `Setup`, `Dashboard`, `Advanced Stats`, `Analysis Data`, and `Candles` when those tabs exist. `Setup` inputs such as starting balance and expected winrate are not reset.

To reset the bot as if it has not run yet, while keeping settings intact:

```bash
npm run reset:all
```

This clears Google Sheets trade and order logs when enabled, rewrites local `trades.csv` and `order-events.csv` to header-only files, rebuilds `stats.csv` from the empty trade log, and resets `bot-state.json` so pending orders, pending settlements, and runtime risk counters start from zero. It preserves `bot.config.json`, `.env`, Google Sheets setup/dashboard tabs, and the `Candles` backtesting tab. Stop the bot before running it.

To print the full reset plan first:

```bash
npm run reset:all:dry-run
```

To print the exact clear targets before changing the spreadsheet:

```bash
npm run sheets:clear:dry-run
```

To print the built-in guide without clearing anything:

```bash
npm run sheets:clear:help
```

To simulate reversing only realized BASE trades from Google Sheets:

```bash
npm run simulate:reverse-base
```

This reads the configured `Trades` tab, excludes `RETRY` rows, flips `UP` to `DOWN` and `DOWN` to `UP`, then prints original versus reversed BASE performance. It does not edit the spreadsheet or local files. Reversed net PnL uses the logged `fee_usd` as a fee estimate and also prints gross PnL.

To backfill the configured `Candles` tab with the latest fetched closed candles:

```bash
npm run sheets:candles:sync
```

To backtest reversed BASE signals directly from the configured `Candles` tab:

```bash
npm run backtest:reverse-base-candles
```

Use `npm run backtest:reverse-base-candles:official` to exclude provisional candle rows.

## Early Entry

When `earlyEntryEnabled=true`, the bot checks the forming candle in three stages before the next contract opens.

- Primary: at `earlyEntryPrimarySecondsBeforeClose`, require at least `earlyEntryPrimaryMinMovePct`.
- Secondary: at `earlyEntrySecondarySecondsBeforeClose`, require at least `earlyEntrySecondaryMinMovePct`.
- Final: at `earlyEntryOrderSecondsBeforeClose`, require only the correct red/green forming candle for the setup.

If the process reaches a later stage without having run an earlier one, it uses the later stage. For example, a tick at the final one-second check uses the color-only final rule instead of spending that tick on the older primary or secondary thresholds.

For BASE setups, a third green trend candle places `DOWN` on the next contract; a third red trend candle places `UP`. For RETRY setups, the same staged checks apply when the forming candle continues the retry trend and would make retry ready.

If a primary or secondary early-entry order is already pending, the final check still runs at `earlyEntryOrderSecondsBeforeClose`. If the forming candle no longer produces the same setup and direction, the bot cancels the pending order when it is not already fully filled.

## Strategy Replay Tests

Replay fixtures live in `fixtures/strategy`. They feed deterministic candle sequences into the strategy and early-entry stage selector without touching Polymarket, Google Sheets, local CSV files, or live order code.

Run all fixtures:

```bash
npm run test:strategy
```

Run one fixture:

```bash
npm run replay:fixture -- fixtures/strategy/base-three-red-up.json
```

Use these tests when changing 3-candle logic, doji behavior, retry behavior, early-entry timing, startup handling, or provisional/official candle behavior.

## No-Trade Window

Set `noTradeWindowEnabled=true` to block new entries during a configured local-time window. The default window is `23:00` to `07:00` in `Europe/Stockholm`.

The window is checked against the target contract candle open time. This means early entry will not place a 23:00 contract at 22:59 if the no-trade window starts at 23:00.

Blocked signals are tracked only for strategy state, not as live orders and not as CSV trades. Open orders and pending trade results are still handled normally.

## Live Execution

Live dry-run and live mode both use:

- Gamma API to find the active up/down event slug: `{asset}-updown-{interval}-{candleStartEpoch}`.
- Gamma market metadata to map `UP` to the `Up` CLOB token and `DOWN` to the `Down` CLOB token.
- CLOB orderbook metadata for `tick_size`, `min_order_size`, and `neg_risk`.

`executionMode: "live_dry_run"` then logs `[LIVE_DRY_RUN]` with the exact BUY order it would place. It does not create a signer, does not derive CLOB credentials, and does not post or cancel orders.

Real live mode additionally uses:

- `@polymarket/clob-client-v2` to submit a GTC post-only limit BUY. It starts at `entryCents` and, when that BUY would be marketable against the current best ask, steps down by the market tick until it finds a non-marketable maker price. The fallback is capped by both `minPostOnlyEntryCents` and `maxPostOnlyEntryFallbackTicks`.
- Automatic cancel at `candleOpenTime + tradeWindowSeconds`.
- Fill checking through authenticated CLOB order and trade data before any due cancel is sent.
- Full-fill confirmation based on successful CLOB trade records for the specific order id. The initial post response status is not enough to count a live trade as filled.
- A local runtime state file so pending live orders and risk counters survive process restart.
- A zero-fill canceled order updates strategy state hypothetically but does not create a trade row.
- A partially filled canceled order logs the filled portion as a realized trade and still updates strategy state using the signal result.

With `livePostOnlyEntryEnabled=true`, the bot keeps the configured dollar stake and recalculates shares from the selected live price. For example, if the signal asks for 50c but 50c is marketable, the default settings try 49c, then 48c. If 48c is also marketable and `livePostOnlyFallbackTakerEnabled=true`, the bot posts a non-post-only limit BUY at 48c. If taker fallback is disabled, the signal is skipped for live trading.

To dry-run against Polymarket without placing orders, use `npm run dry-run`. For manual config, set this in `bot.config.json`:

```json
{
  "executionMode": "live_dry_run",
  "liveTradingEnabled": false
}
```

To enable live mode, keep secrets in `.env`:

```env
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_FUNDER_ADDRESS=0x...
POLYGON_RPC_URL=https://polygon-rpc.com
```

Then set live guards and risk limits in `bot.config.json`:

```json
{
  "liveTradingEnabled": true,
  "polymarketSignatureType": 3,
  "tradeWindowSeconds": 60,
  "maxLiveTradeWindowSeconds": 60,
  "liveFullFillToleranceShares": 0.01,
  "livePostOnlyEntryEnabled": true,
  "livePostOnlyFallbackTakerEnabled": true,
  "minPostOnlyEntryCents": 48,
  "maxPostOnlyEntryFallbackTicks": 2
}
```

For new Polymarket API users, signature type `3` is the deposit wallet flow. The funder address should be the deposit wallet address. You can optionally set `CLOB_API_KEY`, `CLOB_SECRET`, and `CLOB_PASS_PHRASE`; otherwise the bot derives API credentials at startup with the private key.

`liveFullFillToleranceShares` treats tiny CLOB dust differences as full fills. With the default `0.01`, a 6-share order filled as `5.9936` is logged as a full 6-share fill.

Keep `executionMode: "paper"` while testing. `npm run live` forces live mode for that process, but it still requires the live guards above. `RUN_ONCE` is blocked in live mode so the bot cannot place an order and exit before the cancel/fill loop runs.

## Scripts

```bash
npm run dev
npm run dry-run
npm run dry-run:once
npm run live
npm run sheets:candles:sync
npm run backtest:reverse-base-candles
npm run simulate:reverse-base
npm run test:strategy
npm run replay:fixture -- fixtures/strategy/base-three-red-up.json
npm run typecheck
npm run build
```
