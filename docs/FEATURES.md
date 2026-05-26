# Features

This document lists the current bot features and explains how each one works.

## Execution Modes

### Paper Mode

Configured with:

```json
{
  "executionMode": "paper"
}
```

Paper mode does not touch Polymarket trading APIs. It fetches candles, runs the strategy, simulates entries at `entryCents`, resolves trades after candle close, and writes results to the configured log target.

Use paper mode for strategy checks and local development.

### Live Dry-Run Mode

Configured with:

```json
{
  "executionMode": "live_dry_run"
}
```

Or started with:

```bash
npm run dry-run
```

Dry-run mode performs the live preflight path without posting orders. It discovers the Polymarket market, finds the correct token, checks the order book, validates minimum size and tick size, then logs the order it would place.

Use dry-run mode before live trading and after deployment changes.

### Live Mode

Configured with live guards in `bot.config.json`, then started with:

```bash
npm run live
```

Live mode places real Polymarket CLOB limit BUY orders. It is protected by explicit config guards and risk checks.

Required live guard fields:

```json
{
  "liveTradingEnabled": true,
  "priceSource": "polymarket_chainlink",
  "localCsvLoggingEnabled": true
}
```

Secrets must be stored in `.env`.

## TradingView-Style Strategy

The bot implements the 3-candle reversal strategy from the TradingView indicator.

Base rules:

- Last 3 trend candles red means bet `UP`.
- Last 3 trend candles green means bet `DOWN`.
- A trade candle that closes as doji counts as a loss.

The strategy tracks state across candles so retry and reset behavior can match the Pine logic as closely as possible.

## Doji Trend Handling

Configured with:

```json
{
  "ignoreDojiInTrend": false
}
```

When `ignoreDojiInTrend` is `true`, doji candles are skipped during trend detection.

When `ignoreDojiInTrend` is `false`, doji candles inherit the previous non-doji trend color and can count as trend candles.

Trade result handling is separate. If an active trade candle is doji, it is a loss.

## Loss Retry Logic

Configured with:

```json
{
  "useLossRetryLogic": true,
  "retryWaitCandles": 0
}
```

When retry logic is enabled, a loss can arm retry mode.

If an `UP` trade loses, the continuing trend is treated as red. If a `DOWN` trade loses, the continuing trend is treated as green.

The retry direction follows the continuing trend:

- Red continuation retries with `UP`.
- Green continuation retries with `DOWN`.

`retryWaitCandles` controls how many confirming trend candles must pass before retry becomes active. A value of `0` makes retry ready immediately after a loss.

## Hard Reset Mode

Configured with:

```json
{
  "useLossRetryLogic": false
}
```

When retry logic is disabled, a loss blocks trades while the same trend continues. The bot waits for the trend to break, then requires a fresh 3-candle setup after the reset point.

## Early Entry

Configured with:

```json
{
  "earlyEntryEnabled": true,
  "earlyEntryPrimarySecondsBeforeClose": 15,
  "earlyEntryPrimaryMinMovePct": 0.05,
  "earlyEntrySecondarySecondsBeforeClose": 5,
  "earlyEntrySecondaryMinMovePct": 0.02,
  "earlyEntryOrderSecondsBeforeClose": 1
}
```

Early entry can place an order on the next contract before the next candle opens.

The bot checks three stages:

- Primary stage: requires the forming candle to move at least the configured primary percentage.
- Secondary stage: requires the forming candle to move at least the configured secondary percentage.
- Final stage: only requires the forming candle to have the correct red or green color.

When more than one stage is already due, the bot runs the most urgent due stage. This keeps a delayed poll near candle close from spending the final check on an older primary or secondary threshold.

For base signals, the forming candle must become the third same-color trend candle.

For retry signals, the forming candle must continue the retry trend and satisfy the configured wait logic.

If one stage opens a trade for the target candle, the remaining stages for that target candle are skipped.

When a primary or secondary stage opens a pending order, the final stage is still used as a safety validation. At `earlyEntryOrderSecondsBeforeClose`, the bot checks the forming candle again with color-only requirements. If the signal no longer matches the pending trade kind and direction, the bot cancels the pending order when possible and clears the pending trade.

If the order is already fully filled by the time final validation fails, it cannot be canceled. The bot keeps managing the trade until candle close and logs that the order was already filled.

## Startup Candle Skip

When the bot starts, it warms up strategy state from closed candles and skips the candle already in progress.

This prevents the bot from entering a trade midway through a candle that started before the process was running.

When that startup candle closes, the bot logs its resolved open, close, color, and source, then adds it to trend state only. Direct entry on the already-open startup candle is disabled, but early entry for the next candle remains enabled.

## No-Trade Window

Configured with:

```json
{
  "noTradeWindowEnabled": true,
  "noTradeStart": "23:00",
  "noTradeEnd": "07:00",
  "noTradeTimeZone": "Europe/Stockholm"
}
```

The no-trade window blocks new entries during a configured local-time range.

The check uses the target contract candle open time. This matters for early entry because a signal at 22:59 can still target a 23:00 candle.

When a signal is blocked:

- The bot does not place an order.
- The bot still tracks the signal as a strategy-only hypothetical trade.
- Retry state stays aligned with what would have happened.
- No real trade row is added to the configured trade log.

## Polymarket/Chainlink Candle Source

Configured with:

```json
{
  "priceSource": "polymarket_chainlink"
}
```

This is the recommended source for current crypto Up/Down markets.

It uses:

- Polymarket Gamma event metadata for resolved historical candles.
- Polymarket RTDS Chainlink WebSocket updates for current live prices.

This keeps the bot closer to the price source used by Polymarket crypto Up/Down settlement.

Closed trade results prefer official Gamma metadata. The bot uses `priceToBeat` as the open and `finalPrice`, or the next event `priceToBeat`, as the close. If Gamma has already resolved the market outcome but has not published a numeric final price, the bot uses the resolved `Up` or `Down` outcome to build a directional fallback candle. If the newest closed candle is not official yet but RTDS has an open and close, the bot can use that provisional closed candle for trend state and entry decisions so it does not stall.

Warmup uses the newest contiguous closed candles available from Gamma metadata. A missing older historical candle reduces warmup depth, but it does not block startup as long as enough recent candles exist for the strategy.

If official Gamma metadata later replaces a provisional closed candle, the bot logs `[CANDLE_CORRECTION]` and updates the stored candle.

When the process starts in the middle of a candle, the first RTDS tick is not treated as the official candle open. The bot corrects the live candle open from Gamma `priceToBeat` or the previous official close when available, then uses RTDS updates for the live close.

## Binance Candle Source

Configured with:

```json
{
  "priceSource": "binance"
}
```

Binance candles are available for comparison and simple backtesting. They can disagree with Polymarket Chainlink settlement, so they should not be treated as the preferred live source for current crypto Up/Down markets.

## Polymarket Market Discovery

For dry-run and live mode, the bot maps a strategy signal to a Polymarket market by building the Up/Down event slug from:

- `polymarketAssetSlug`
- `polymarketIntervalSlug`
- candle open time

It then reads Gamma metadata and resolves the correct `Up` or `Down` token id.

## Limit Order Placement

Live mode posts GTC limit BUY orders at `entryCents`.

Before posting, the bot checks:

- Market is active.
- Market is not closed.
- Order book is enabled.
- Tick size is supported.
- Order size is at least the market minimum.
- Runtime risk limits allow the trade.

The bot calculates shares from:

```text
stakeUsd / (entryCents / 100)
```

## Order Cancel And Fill Tracking

Live orders have a cancel time:

```text
candleOpenTime + tradeWindowSeconds
```

The bot keeps polling while the order is pending.

If the order fills, the resolved trade is logged after candle close.

Before a due cancel is sent, the bot checks authenticated CLOB trade records for successful matched size on the specific order id. If the order is already fully filled, it logs `[LIVE_FILL]` and does not send the cancel. Tiny CLOB dust differences are treated as full fills using `liveFullFillToleranceShares`.

If the order does not fully fill, the order is canceled when due. A non-zero partial fill outside the tolerance is logged proportionally. A zero-fill order updates strategy state hypothetically after candle close, but no real trade row is written.

## Runtime Risk Limits

Configured with:

```json
{
  "maxEntryCents": 51,
  "maxStakeUsd": 5,
  "maxDailyLossUsd": 50,
  "maxTradesPerDay": 50,
  "maxLiveTradeWindowSeconds": 300,
  "liveFullFillToleranceShares": 0.01
}
```

Risk checks block live and dry-run orders when:

- Entry price exceeds the configured max.
- Stake exceeds the configured max.
- Max trades per day has been reached.
- Realized daily loss limit has been reached.
- Live trade window exceeds the configured max.

`liveFullFillToleranceShares` is a dust tolerance for CLOB fill accounting. With the default `0.01`, a 6-share order filled as `5.9936` is treated as a full 6-share fill.

Risk counters are persisted to `runtimeStateFile` so live limits survive process restart.

## Local CSV Trade Log

Configured with:

```json
{
  "localCsvLoggingEnabled": true,
  "logFile": "trades.csv",
  "orderEventsFile": "order-events.csv",
  "runtimeStateFile": "bot-state.json"
}
```

When `localCsvLoggingEnabled` is `true`, the bot writes one row per resolved paper or filled live trade.

The trade log includes:

- Signal time.
- Candle open and close time.
- Symbol.
- Direction.
- Entry price.
- Stake.
- Shares.
- Open and close price.
- Result.
- PnL.
- Signal reason.
- Base or retry kind.
- Live market metadata when available.

The order events log records live order placement, fill, final-check cancel, and not-filled events. Live mode requires local CSV logging so these audit records exist even when Google Sheets is unavailable.

## Local CSV Stats

Configured with:

```json
{
  "localCsvLoggingEnabled": true,
  "statsFile": "stats.csv"
}
```

When `localCsvLoggingEnabled` is `true`, the bot rebuilds aggregate stats from `trades.csv` after each resolved trade.

Stats scopes:

- `TOTAL`
- `BASE`
- `RETRY`
- `UP`
- `DOWN`
- `BASE_UP`
- `BASE_DOWN`
- `RETRY_UP`
- `RETRY_DOWN`

Each row includes trades, wins, losses, winrate, total PnL, average PnL, total stake, average stake, and average entry cents.

## Google Sheets Logging

Configured with:

```json
{
  "localCsvLoggingEnabled": false,
  "googleSheetsEnabled": true,
  "googleSheetsSpreadsheetId": "your-spreadsheet-id",
  "googleSheetsTradesSheetName": "Trades",
  "googleSheetsStatsSheetName": "Stats",
  "googleSheetsOrderEventsSheetName": "Order Events",
  "googleSheetsRequestTimeoutMs": 10000
}
```

When enabled, the bot writes the same trade and stats data to an existing Google spreadsheet.

The spreadsheet must be shared with a Google service account. The service account email and private key are stored in `.env`:

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

The bot creates the configured `Trades`, `Stats`, and `Order Events` tabs if they do not exist. It appends resolved trades to the trades tab and refreshes the stats tab from realized rows already present in that same Google Sheets `Trades` tab. Paper rows with no `order_id` are counted. Live rows are counted only when `live_filled` is `TRUE`.

The `Order Events` tab records live execution events that are not trades:

- `ORDER_PLACED`: a real live limit order was posted.
- `ORDER_FILLED`: a live order was fully filled and logged as a trade.
- `FINAL_CHECK_CANCELED`: a primary or secondary early-entry order was canceled by the final one-second validation.
- `ORDER_NOT_FILLED`: an order reached candle close without being fully filled. If `filled_size` is greater than zero, the filled portion is still logged proportionally in `Trades`. These rows include `missed_result`, `missed_pnl`, and `missed_close` when the candle result is known, so missed fills can be analyzed separately from realized trades. For partial fills, `missed_pnl` is sized only to the unfilled remainder.

Live CLOB taker fees are deducted from realized `pnl` and written to the trailing `fee_usd` column in `Trades`. Maker fills currently log zero fee unless Polymarket reports a fee-enabled maker structure for the market.

`live_status` is the initial status returned by Polymarket when the order was posted. `live` means the order was accepted and open at first. `matched` means the post response matched against liquidity immediately. `partial` means the order did not fully fill before cancel, but a non-zero filled portion was logged proportionally as a realized trade. Realized performance should use `live_filled`, not `live_status`.

For paper mode, `localCsvLoggingEnabled` can be set to `false` when Google Sheets is the only desired log target. Live mode requires local CSV logging for durable audit and recovery support.

Google Sheets writes are queued outside the order-management path and each HTTP request is bounded by `googleSheetsRequestTimeoutMs`. When local CSV logging is enabled, startup and failed-write recovery reconcile local `trades.csv` and `order-events.csv` into Google Sheets by appending rows that are missing by order or event key, then refreshing stats. Startup reconciliation does not bulk import old local CSV rows when both raw Google Sheets tabs are empty.

Run this to clear the Google Sheets trade log and restart the Google Sheets dashboard from zero:

```bash
npm run sheets:clear
```

Run this to print the exact clear targets before changing the spreadsheet:

```bash
npm run sheets:clear:dry-run
```

Run this to show the built-in guide without clearing anything:

```bash
npm run sheets:clear:help
```

The clear script only affects the configured raw Google Sheets tabs: `Trades` back to A:W headers, `Order Events` back to A:AA headers, and `Stats` rebuilt from the now-empty `Trades` tab. It preserves `Setup`, `Dashboard`, `Advanced Stats`, and `Analysis Data` when those tabs exist. It does not reset `Setup` inputs and does not modify local CSV files.

For a full fresh-start reset, use:

```bash
npm run reset:all
```

This clears Google Sheets logs when enabled, resets local `trades.csv`, `order-events.csv`, `stats.csv`, and `bot-state.json`, and preserves `bot.config.json`, `.env`, and Google Sheets setup/dashboard tabs. Stop the bot before running it.

Google Sheets failures are logged as errors, but they do not stop trade management. If local CSV logging is enabled, it continues separately.

## Config Separation

Normal bot settings live in `bot.config.json`.

Secrets and account-specific values live in `.env`.

This keeps deployment-specific options easy to edit while reducing the chance of committing private keys or API credentials.

## Local Config Template

`bot.config.example.json` is tracked in Git and shows the supported config shape.

`bot.config.json` is ignored by Git and should be created locally from the example.

## Secret Template

`.env.example` is tracked and contains only secret or account-specific field names.

`.env` is ignored by Git and should contain real values only on the machine running the bot.

## PM2 Deployment

The bot is designed to run 24/7 on a Linux VPS with PM2.

Typical command:

```bash
pm2 start npm --name polymarket-bot -- run live
```

PM2 keeps the bot running after SSH disconnects and can restore it after reboot when startup is configured.

## Graceful Shutdown

The bot listens for `SIGINT` and `SIGTERM`.

On shutdown it:

- Stops the poll loop.
- Cancels a pending live order when possible.
- Closes Polymarket Chainlink WebSocket sources.

## Build Cleanliness

`npm run build` runs a clean step before TypeScript compilation.

This removes stale generated files from `dist/` so source reorganizations do not leave old JavaScript artifacts behind.
