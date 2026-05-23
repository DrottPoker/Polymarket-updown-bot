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
  trading/      Strategy, simulated trades, and runtime risk checks
  index.ts      Main polling loop and trade lifecycle
```

## Documentation

- [Overview](docs/OVERVIEW.md)
- [Features](docs/FEATURES.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Operations](docs/OPERATIONS.md)

## Price Source

`priceSource: "polymarket_chainlink"` makes the bot use the same reference family as current Polymarket crypto Up/Down markets:

- Historical warmup candles come from Polymarket Gamma event metadata: `priceToBeat` as open and `finalPrice` as close.
- Live/current candles are aggregated from Polymarket RTDS `crypto_prices_chainlink` WebSocket updates.

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
- The startup candle is skipped for entries, then logged with its resolved open, close, and color when it closes.

## Spreadsheet Logs

Local CSV logging is controlled by `localCsvLoggingEnabled`. When it is `true`, the bot writes every resolved trade to `logFile` as a spreadsheet-friendly CSV. New live trades include Polymarket metadata such as market slug, token id, order id, live status, fill status, live price, and live size.

When local CSV logging is enabled, the bot rewrites `statsFile` after each resolved trade with aggregate statistics for `TOTAL`, `BASE`, `RETRY`, `UP`, `DOWN`, `BASE_UP`, `BASE_DOWN`, `RETRY_UP`, and `RETRY_DOWN`.

Those files can be opened directly in Excel or imported into Google Sheets.

When Google Sheets logging is enabled, set `localCsvLoggingEnabled` to `false` if you want the VPS to avoid creating or changing local `trades.csv` and `stats.csv` files.

## Google Sheets Logging

The bot can also write resolved trades and aggregate stats to an existing Google spreadsheet.

Enable it in `bot.config.json`:

```json
{
  "localCsvLoggingEnabled": false,
  "googleSheetsEnabled": true,
  "googleSheetsSpreadsheetId": "your-spreadsheet-id",
  "googleSheetsTradesSheetName": "Trades",
  "googleSheetsStatsSheetName": "Stats"
}
```

Use a Google service account and share the spreadsheet with the service account email as an editor. Store the service account credentials in `.env`:

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Google Sheets stats are calculated from rows that exist in the configured `Trades` tab. Local CSV trades are not imported or counted in the Google Sheets dashboard. Google Sheets errors are logged, but they do not stop the bot from managing trades.

To clear the Google Sheets trade log and restart the dashboard from zero:

```bash
npm run sheets:clear
```

To print the built-in guide without clearing anything:

```bash
npm run sheets:clear:help
```

## Early Entry

When `earlyEntryEnabled=true`, the bot checks the forming candle in three stages before the next contract opens.

- Primary: at `earlyEntryPrimarySecondsBeforeClose`, require at least `earlyEntryPrimaryMinMovePct`.
- Secondary: at `earlyEntrySecondarySecondsBeforeClose`, require at least `earlyEntrySecondaryMinMovePct`.
- Final: at `earlyEntryOrderSecondsBeforeClose`, require only the correct red/green forming candle for the setup.

For BASE setups, a third green trend candle places `DOWN` on the next contract; a third red trend candle places `UP`. For RETRY setups, the same staged checks apply when the forming candle continues the retry trend and would make retry ready.

If a primary or secondary early-entry order is already pending, the final check still runs at `earlyEntryOrderSecondsBeforeClose`. If the forming candle no longer produces the same setup and direction, the bot cancels the pending order when it is not already fully filled.

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

- `@polymarket/clob-client-v2` to submit a GTC limit BUY at `entryCents`.
- Automatic cancel at `candleOpenTime + tradeWindowSeconds`.
- Fill checking through authenticated CLOB order and trade data before any due cancel is sent.
- Full-fill confirmation based on successful CLOB trade records for the specific order id. The initial post response status is not enough to count a live trade as filled.
- An unfilled or partially filled canceled order updates strategy state hypothetically but does not create a trade row.

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
  "liveConfirmation": "PLACE_REAL_POLYMARKET_ORDERS",
  "polymarketSignatureType": 3,
  "tradeWindowSeconds": 60,
  "maxLiveTradeWindowSeconds": 60
}
```

For new Polymarket API users, signature type `3` is the deposit wallet flow. The funder address should be the deposit wallet address. You can optionally set `CLOB_API_KEY`, `CLOB_SECRET`, and `CLOB_PASS_PHRASE`; otherwise the bot derives API credentials at startup with the private key.

Keep `executionMode: "paper"` while testing. `npm run live` forces live mode for that process, but it still requires the live guards above. `RUN_ONCE` is blocked in live mode so the bot cannot place an order and exit before the cancel/fill loop runs.

## Scripts

```bash
npm run dev
npm run dry-run
npm run dry-run:once
npm run live
npm run typecheck
npm run build
```
