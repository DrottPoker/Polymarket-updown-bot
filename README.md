# Polymarket Up/Down Paper Bot

Node.js/TypeScript paper-trading bot for an ETH/USDT configurable-interval 3-candle reversal strategy intended for Polymarket Up/Down markets.

By default this runs in paper mode. It fetches Binance ETH/USDT candles, detects TradingView-style base/retry signals, simulates entry at the configured cents price, resolves after the candle closes, and writes results to CSV.

Live Polymarket execution is available behind explicit env guards. Do not enable it until paper behavior, funding, allowances, and risk limits are verified.

## Setup

```bash
npm install
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

See `.env.example` for defaults:

```env
SYMBOL=ETHUSDT
INTERVAL=15m
ENTRY_CENTS=51
TRADE_WINDOW_SECONDS=1000
STAKE_USD=5
EV_STAKE_USD=100
POLL_MS=1000
CANDLE_LIMIT=300
LOG_FILE=trades.csv
BINANCE_BASE_URL=https://api.binance.com
IGNORE_DOJI_IN_TREND=false
USE_LOSS_RETRY_LOGIC=true
RETRY_WAIT_CANDLES=0
EARLY_ENTRY_ENABLED=false
EARLY_ENTRY_SECONDS_BEFORE_CLOSE=15
EARLY_ENTRY_MIN_MOVE_PCT=0.05

EXECUTION_MODE=paper
LIVE_TRADING_ENABLED=false
LIVE_CONFIRMATION=

GAMMA_BASE_URL=https://gamma-api.polymarket.com
CLOB_HOST=https://clob.polymarket.com
POLYGON_RPC_URL=https://polygon-rpc.com
POLYMARKET_ASSET_SLUG=eth
POLYMARKET_INTERVAL_SLUG=15m
POLYMARKET_CHAIN_ID=137
POLYMARKET_SIGNATURE_TYPE=3
POLYMARKET_FUNDER_ADDRESS=
POLYMARKET_PRIVATE_KEY=
CLOB_API_KEY=
CLOB_SECRET=
CLOB_PASS_PHRASE=

MAX_ENTRY_CENTS=51
MAX_STAKE_USD=5
MAX_DAILY_LOSS_USD=25
MAX_TRADES_PER_DAY=20
MAX_LIVE_TRADE_WINDOW_SECONDS=60
```

## Strategy

- Base signal: last 3 trend candles red means bet `UP`; last 3 trend candles green means bet `DOWN`.
- Doji trend handling follows `IGNORE_DOJI_IN_TREND`. When false, doji candles inherit the previous non-doji trend color.
- Active trade doji results count as `LOSS`, matching the TradingView script.
- When `USE_LOSS_RETRY_LOGIC=true`, a loss can arm retry mode after `RETRY_WAIT_CANDLES`.
- When retry logic is off, a loss blocks same-trend continuation until the trend breaks and 3 fresh candles have formed.
- The bot warms up strategy state from `CANDLE_LIMIT` Binance candles at startup.
- Optional early entry can place the next contract order before candle close when the forming candle is already the third trend candle.

## Early Entry

When `EARLY_ENTRY_ENABLED=true`, the bot checks the forming candle during the final `EARLY_ENTRY_SECONDS_BEFORE_CLOSE` seconds.

For BASE setups, if the forming candle is at least `EARLY_ENTRY_MIN_MOVE_PCT` above the previous closed candle and is the third green trend candle, it places `DOWN` on the next contract. If it is at least that much below and is the third red trend candle, it places `UP` on the next contract.

For RETRY setups, if the bot is waiting for retry confirmation and the forming candle continues the retry trend by at least `EARLY_ENTRY_MIN_MOVE_PCT`, it places the retry order on the next contract as soon as that forming candle would make retry ready.

## Live Execution

Live dry-run and live mode both use:

- Gamma API to find the active up/down event slug: `{asset}-updown-{interval}-{candleStartEpoch}`.
- Gamma market metadata to map `UP` to the `Up` CLOB token and `DOWN` to the `Down` CLOB token.
- CLOB orderbook metadata for `tick_size`, `min_order_size`, and `neg_risk`.

`EXECUTION_MODE=live_dry_run` then logs `[LIVE_DRY_RUN]` with the exact BUY order it would place. It does not create a signer, does not derive CLOB credentials, and does not post or cancel orders.

Real live mode additionally uses:

- `@polymarket/clob-client-v2` to submit a GTC limit BUY at `ENTRY_CENTS`.
- Automatic cancel at `candleOpenTime + TRADE_WINDOW_SECONDS`.
- Fill checking through authenticated CLOB trades; an unfilled canceled order does not update retry/result state.

To dry-run against Polymarket without placing orders:

```env
EXECUTION_MODE=live_dry_run
LIVE_TRADING_ENABLED=false
POLYMARKET_PRIVATE_KEY=
CLOB_API_KEY=
CLOB_SECRET=
CLOB_PASS_PHRASE=
```

To enable live mode, set all of these intentionally:

```env
EXECUTION_MODE=live
LIVE_TRADING_ENABLED=true
LIVE_CONFIRMATION=PLACE_REAL_POLYMARKET_ORDERS
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_FUNDER_ADDRESS=0x...
POLYMARKET_SIGNATURE_TYPE=3
POLYGON_RPC_URL=https://polygon-rpc.com
TRADE_WINDOW_SECONDS=60
MAX_LIVE_TRADE_WINDOW_SECONDS=60
```

For new Polymarket API users, signature type `3` is the deposit wallet flow. The funder address should be the deposit wallet address. You can optionally set `CLOB_API_KEY`, `CLOB_SECRET`, and `CLOB_PASS_PHRASE`; otherwise the bot derives API credentials at startup with the private key.

Keep `EXECUTION_MODE=paper` while testing. `npm run live` forces `EXECUTION_MODE=live` for that process, but it still requires the live env guards above. `RUN_ONCE` is blocked in live mode so the bot cannot place an order and exit before the cancel/fill loop runs.

## Scripts

```bash
npm run dev
npm run dry-run
npm run dry-run:once
npm run live
npm run typecheck
npm run build
```
