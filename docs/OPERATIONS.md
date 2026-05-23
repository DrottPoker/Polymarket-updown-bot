# Polymarket Bot Operations Guide

This guide explains how to install, configure, run, monitor, and update the bot on a Linux VPS.

## Requirements

- Ubuntu/Debian VPS
- Node.js LTS
- Git
- A Polymarket account and funded deposit wallet
- A Polygon RPC URL
- Polymarket API credentials or a private key that can derive them
- A server region that is allowed by Polymarket

Before running live trading, check the server geoblock status:

```bash
curl https://polymarket.com/api/geoblock
```

If the response says `"blocked": true`, do not run the bot from that server.

## Install System Dependencies

```bash
apt update
apt upgrade -y
apt install -y git curl build-essential
```

Install Node.js with `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install --lts
nvm use --lts
```

Verify:

```bash
node -v
npm -v
```

## Clone And Build

```bash
mkdir -p /opt/bots
cd /opt/bots
git clone <YOUR_GITHUB_REPO_URL> polymarket-updown-bot
cd polymarket-updown-bot
npm ci
npm run build
```

## Configure Bot Settings

Create the local config and secret files:

```bash
cp bot.config.example.json bot.config.json
cp .env.example .env
nano bot.config.json
nano .env
```

`bot.config.json` contains normal bot settings. Minimum live settings:

```json
{
  "priceSource": "polymarket_chainlink",
  "liveTradingEnabled": true,
  "liveConfirmation": "PLACE_REAL_POLYMARKET_ORDERS",
  "polymarketSignatureType": 3,
  "stakeUsd": 5,
  "maxStakeUsd": 5,
  "maxDailyLossUsd": 25,
  "maxTradesPerDay": 20
}
```

Recommended:

```json
{
  "logFile": "trades.csv",
  "statsFile": "stats.csv",
  "localCsvLoggingEnabled": true,
  "earlyEntryEnabled": true,
  "earlyEntryPrimarySecondsBeforeClose": 15,
  "earlyEntryPrimaryMinMovePct": 0.05,
  "earlyEntrySecondarySecondsBeforeClose": 5,
  "earlyEntrySecondaryMinMovePct": 0.02,
  "earlyEntryOrderSecondsBeforeClose": 1,
  "noTradeWindowEnabled": true,
  "noTradeStart": "23:00",
  "noTradeEnd": "07:00",
  "noTradeTimeZone": "Europe/Stockholm"
}
```

`.env` contains secrets and private/account-specific values only:

```env
POLYGON_RPC_URL=https://...
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_FUNDER_ADDRESS=0x...
CLOB_API_KEY=
CLOB_SECRET=
CLOB_PASS_PHRASE=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
```

Never commit `.env` or `bot.config.json` to GitHub.

`priceSource: "polymarket_chainlink"` uses Polymarket Gamma metadata for historical resolved candles and the Polymarket RTDS Chainlink WebSocket for live/current candles. This is the recommended source for current crypto Up/Down markets because Binance candles can disagree with Chainlink-resolved settlement.

During startup, the bot warms up from the latest contiguous closed Polymarket/Chainlink candles it can build. If older Gamma metadata has a gap, the bot starts with the newer contiguous history instead of repeatedly failing on that old candle.

If the bot starts in the middle of a live candle, the candle open is corrected from Gamma `priceToBeat` when available. This avoids treating the first RTDS tick seen after process start as the official Polymarket open.

The no-trade window blocks new entries only. The bot still manages already-open orders, cancels due orders, resolves results, and keeps strategy state current. The time window is checked against the target contract candle open time, so early entry will also be blocked for a contract that opens inside the window.

Early-entry orders opened at the primary or secondary checks are validated again at the final check. If the forming candle has changed so the setup no longer matches the pending trade, the bot cancels the pending order when it is not already fully filled.

On startup, the candle already in progress is skipped for entries. When it closes, the bot logs the resolved open, close, and color before adding it to trend state.

## Google Sheets Logging

The bot can write trade rows and stats to an existing spreadsheet in Google Drive.

1. Create a Google Cloud service account.
2. Enable the Google Sheets API for that Google Cloud project.
3. Create a JSON key for the service account.
4. Open your spreadsheet in Google Drive.
5. Share the spreadsheet with the service account email as an editor.
6. Copy the spreadsheet id from the URL.

The spreadsheet id is the part between `/d/` and `/edit`:

```text
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
```

Enable Google Sheets logging in `bot.config.json`:

```json
{
  "localCsvLoggingEnabled": false,
  "googleSheetsEnabled": true,
  "googleSheetsSpreadsheetId": "SPREADSHEET_ID",
  "googleSheetsTradesSheetName": "Trades",
  "googleSheetsStatsSheetName": "Stats",
  "googleSheetsOrderEventsSheetName": "Order Events"
}
```

Add the service account credentials to `.env`:

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Google Sheets stats are calculated from the configured `Trades` tab in Google Sheets. Order placement, fill, final-check cancel, and unfilled-order events are written to the configured `Order Events` tab so execution quality can be analyzed without counting those rows as filled trades. Local CSV trades are not imported into Google Sheets and are not counted in the Google Sheets dashboard.

When `localCsvLoggingEnabled` is `false`, the bot does not create, migrate, append, or refresh local CSV log files. This is recommended when Google Sheets is your main trade log on a VPS.

To clear the Google Sheets trade log and reset the Google Sheets dashboard:

```bash
npm run sheets:clear
```

To show the built-in script guide without clearing anything:

```bash
npm run sheets:clear:help
```

This clears the configured `Trades` and `Order Events` tabs back to their header rows and rebuilds the configured `Stats` tab from that blank trade log. It does not delete or edit local `trades.csv` or `stats.csv`.

## Dry Run

Run a single preflight cycle:

```bash
npm run dry-run:once
```

Run continuous dry-run:

```bash
npm run dry-run
```

Stop with:

```bash
Ctrl + C
```

Dry-run does not place real orders.

## Manual Live Test

Before live trading, enable Polymarket's own auto-redeem wins option in the Polymarket UI.

Run live manually:

```bash
npm run live
```

Watch the logs. Stop with:

```bash
Ctrl + C
```

Do not run manual live mode at the same time as PM2.

When a live order fills after it was first posted as `filled: false`, the bot logs `[LIVE_FILL]` once authenticated CLOB trade records show successful matched size for the specific order id. The bot checks for a full fill before sending a due cancel, so already-filled orders should not be canceled just because the initial post response said `filled: false`.

The initial order response status is not enough to count a live trade. If the order is not fully matched, the bot cancels it when due, updates strategy state hypothetically, and does not write a real trade row to Google Sheets or local CSV.

## Run 24/7 With PM2

Install PM2:

```bash
npm install -g pm2
```

Start the bot:

```bash
cd /opt/bots/polymarket-updown-bot
pm2 start npm --name polymarket-bot -- run live
```

Check status:

```bash
pm2 status
```

View logs:

```bash
pm2 logs polymarket-bot
```

Exit the log view with `Ctrl + C`. The bot keeps running.

Enable startup after reboot:

```bash
pm2 save
pm2 startup
```

PM2 will print a command beginning with `sudo env PATH=...`. Copy and run that exact command.

## Common PM2 Commands

Stop the bot:

```bash
pm2 stop polymarket-bot
```

Start the bot:

```bash
pm2 start polymarket-bot
```

Restart the bot:

```bash
pm2 restart polymarket-bot
```

Show status:

```bash
pm2 status
```

Show logs:

```bash
pm2 logs polymarket-bot
```

## Update The Bot

```bash
cd /opt/bots/polymarket-updown-bot
pm2 stop polymarket-bot
git pull
npm ci
npm run build
pm2 start polymarket-bot
```

If the bot is not managed by PM2, stop the manual `npm run live` process first.

If `stats.csv` blocks an update because it was changed locally on the VPS, back it up or discard it once before pulling the version where CSV logging is disabled:

```bash
cp stats.csv stats.csv.backup
git checkout -- stats.csv
git pull
```

## Trade And Stats Files

Local CSV files are optional. They are only used when `localCsvLoggingEnabled` is `true`.

When enabled, the bot writes resolved trades to:

```text
trades.csv
```

When enabled, the bot writes aggregate statistics to:

```text
stats.csv
```

These files can be opened in Excel or imported into Google Sheets.

`trades.csv` contains one row per resolved trade.

`stats.csv` contains aggregate rows for:

- `TOTAL`
- `BASE`
- `RETRY`
- `UP`
- `DOWN`
- `BASE_UP`
- `BASE_DOWN`
- `RETRY_UP`
- `RETRY_DOWN`

## Important Safety Rules

- Run only one bot instance at a time.
- Do not run `npm run live` while PM2 is also running the bot.
- Use a separate wallet with limited funds.
- Keep `maxDailyLossUsd`, `maxTradesPerDay`, and `maxStakeUsd` conservative.
- Check `pm2 logs polymarket-bot` after every deploy or config change.
- Keep Polymarket's own auto-redeem wins enabled in the UI.
- Do not run live trading from a blocked region.

## Troubleshooting

If the bot does not start:

```bash
pm2 logs polymarket-bot
```

If dependencies are broken:

```bash
rm -rf node_modules
npm ci
npm run build
```

If live orders are rejected with a geoblock error:

```bash
curl https://polymarket.com/api/geoblock
```

If it says blocked, use a server in an allowed region. Do not try to bypass Polymarket restrictions.

If PM2 does not restart after reboot:

```bash
pm2 save
pm2 startup
```

Run the command that PM2 prints.
