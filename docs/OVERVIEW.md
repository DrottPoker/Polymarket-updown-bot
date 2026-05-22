# Overview

Polymarket Up/Down Bot is a focused TypeScript trading bot for short-duration crypto Up/Down markets. It turns a TradingView-tested 3-candle reversal strategy into a live-running system that can observe Polymarket-aligned prices, prepare entries before the next candle opens, place controlled limit orders, and keep spreadsheet-friendly trade statistics.

The bot is built for a practical workflow: test in paper mode, verify against real Polymarket markets in dry-run mode, then enable live trading only after config, wallet, risk limits, and deployment are ready.

## What It Does

The bot watches configurable candle intervals, normally ETH 5-minute Up/Down markets, and looks for trend exhaustion.

The core idea is simple:

- Three red trend candles can trigger an `UP` entry.
- Three green trend candles can trigger a `DOWN` entry.
- A loss can optionally activate retry logic if the trend continues.

This logic is modeled after the TradingView indicator used to backtest the strategy. The bot keeps the same important behavior around doji candles, retry state, loss handling, and fresh setup resets.

## Why It Exists

Manual Up/Down trading is timing-sensitive. A trade can look valid seconds before the next contract opens, but waiting until the candle starts can make the desired limit price unavailable.

This bot is designed to solve that operational problem.

It can monitor the forming candle, detect that the next contract is likely to become a valid setup, and place the next order before the new candle opens. That gives the limit order a better chance to be resting at the target price when the market becomes active.

## Price Alignment

For current Polymarket crypto Up/Down markets, the bot can use Polymarket/Chainlink data instead of Binance candles.

That matters because a strategy can look correct on Binance but settle differently on Polymarket if the market uses a different reference price.

The default architecture uses:

- Polymarket Gamma metadata for historical resolved candles.
- Polymarket RTDS Chainlink WebSocket prices for the live candle.

This keeps strategy decisions closer to the same price family used by the markets being traded.

## Controlled Live Trading

Live trading is not just a switch. It requires explicit guards:

- Live mode must be selected.
- Live trading must be enabled.
- A confirmation phrase must match exactly.
- Wallet and RPC settings must be present.
- Entry, stake, daily loss, trade count, and live-window limits must pass.

This makes accidental live execution harder. The bot is intended to be run carefully, with small stakes, limited wallet funding, and dry-run verification before real orders.

## Order Behavior

When a live signal appears, the bot finds the correct Polymarket Up/Down contract, resolves the `Up` or `Down` token, checks the order book metadata, and posts a GTC limit BUY order at the configured entry price.

If the order fills, the bot resolves the trade after candle close and logs the result.

If the order does not fill, the bot cancels it after the configured trade window. The strategy can still update hypothetically so retry behavior remains consistent, but the unfilled order is not counted as a real trade in the spreadsheet log.

## Operating Model

The bot is designed for a small VPS deployment:

- Ubuntu or Debian Linux.
- Node.js LTS.
- Local `bot.config.json`.
- Local `.env`.
- PM2 for 24/7 process management.
- CSV files for trade and stats output.

This keeps the system simple. There is no database requirement, no web dashboard requirement, and no cloud platform lock-in.

## Reporting

Every resolved trade is written to a CSV file that can be opened in Excel or imported into Google Sheets.

The bot can also mirror trades and stats directly into an existing Google spreadsheet. That makes it easier to review results from another machine without logging into the VPS or copying CSV files manually.

The bot also maintains a second stats CSV with aggregate performance by:

- Total trades.
- Base trades.
- Retry trades.
- Up trades.
- Down trades.
- Base and retry direction splits.

The goal is to make strategy review easy without adding unnecessary infrastructure.

## Current Positioning

This is not a generic trading framework. It is a purpose-built Polymarket Up/Down execution bot for one strategy family.

That focus is useful. The codebase can stay small, the config can stay readable, and the live execution path can stay tightly controlled.

The project is best used as a disciplined trading tool:

- Backtest and reason about the strategy in TradingView.
- Run the bot in paper mode.
- Compare logs against expected signals.
- Run dry-run against live Polymarket markets.
- Start live mode only when the behavior is understood.

The bot will not make the strategy profitable by itself. Its job is to execute the defined strategy consistently, log what happened, and reduce manual timing mistakes.
