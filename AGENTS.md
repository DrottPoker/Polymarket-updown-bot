# Agent Instructions

These instructions apply to the whole repository.

## Project Context

- This repo is a Node.js and TypeScript Polymarket Up/Down trading bot.
- The source code lives in `src/`.
- Build output in `dist/` is generated and must not be edited manually.
- The bot can run in `paper`, `live_dry_run`, and `live` modes.
- Live mode places real Polymarket orders. Treat live execution changes as high risk.
- The bot is commonly deployed on a Linux VPS with PM2.

## Working Style

- Treat this repo as a production trading system. Prefer small, scoped changes over broad rewrites.
- Read the relevant code and docs before editing. Do not assume docs are current.
- Keep behavior aligned with the current architecture:
  - `src/index.ts` owns the main polling loop and trade lifecycle.
  - `src/config/appConfig.ts` owns config loading and validation.
  - `src/domain/types.ts` owns shared domain types.
  - `src/marketData/candles.ts` selects the configured candle source.
  - `src/marketData/polymarketChainlinkCandles.ts` builds Polymarket/Chainlink candles.
  - `src/polymarket/marketDiscovery.ts` maps bot trades to Polymarket markets and tokens.
  - `src/polymarket/liveExecutor.ts` owns live CLOB order placement, fill checks, and cancels.
  - `src/trading/strategy.ts` owns TradingView-style strategy state and signal decisions.
  - `src/trading/paperBroker.ts` owns simulated trade construction and settlement.
  - `src/trading/riskManager.ts` owns runtime risk checks.
  - `src/logging/logger.ts` owns console, CSV, and stats output.
  - `src/logging/googleSheetsLogger.ts` owns optional Google Sheets mirroring.
- Do not bypass risk guards, live confirmation checks, no-trade windows, or startup-candle skip behavior without an explicit user request.
- Do not run real live trading commands as a test. Use paper mode or dry-run unless the user explicitly asks for live execution.

## Language and Typography

- Write all code, comments, variable names, function names, and documentation in English.
- Do not write Swedish or other non-English language in code, comments, or docs.
- Do not use em dashes anywhere in code, comments, strings, docs, or user-facing text.
- Use a regular hyphen or rewrite the sentence instead.

## Config and Secrets

- General bot options belong in `bot.config.json`.
- `bot.config.example.json` is the tracked template and should be updated when config shape changes.
- `bot.config.json` is local and git-ignored. It may exist in the workspace but must not be staged or committed.
- Secrets and private/account-specific values belong in `.env` only.
- `.env` is git-ignored and must not be printed, staged, committed, or copied into docs.
- Keep `.env.example` limited to secrets and private/account-specific values.
- Do not hardcode thresholds, timings, URLs, limits, file paths, feature flags, or risk settings when they should be configurable.
- Any new config field must be loaded and validated in `src/config/appConfig.ts`, documented in `bot.config.example.json`, and mentioned in docs when user-facing.

## Trading and Safety Rules

- Default to paper or live dry-run behavior for verification.
- Never remove or weaken these live-mode protections unless explicitly requested:
  - `liveTradingEnabled`
  - `liveConfirmation`
  - private key and funder address validation
  - stake, entry, daily loss, trade count, and live window limits
- Keep unfilled-order behavior intentional: unfilled live orders may update strategy state hypothetically, but must not be logged as real CSV trades.
- Keep Polymarket settlement source alignment in mind. Current crypto Up/Down logic should use `polymarket_chainlink` unless the task explicitly asks for Binance comparison.
- For live order changes, preserve cancel and fill tracking so the bot cannot place an order and exit before managing it.

## Code Style

- Use `npm` scripts from the repo root.
- Prefer explicit, readable variable names.
- Keep comments concise and useful.
- Async code that touches network, files, or orders must handle errors.
- Prefer structured parsing and typed helpers over ad hoc string manipulation.
- Do not edit generated files in `dist/`.
- Do not manually modify `trades.csv` or `stats.csv` unless the task is explicitly about repairing local logs.

## Quality Checks

Run relevant checks before finishing TypeScript or config-loading changes:

```bash
npm run typecheck
npm run build
```

For behavior that depends on external market data, prefer paper or dry-run checks:

```bash
npm run dev:once
npm run dry-run:once
```

Do not run `npm run live` as a test unless the user explicitly asks for live execution.

## Documentation

- Update `README.md` and `docs/OPERATIONS.md` when behavior, config, deployment, scripts, or live trading flow changes.
- Keep examples consistent with `npm`, `bot.config.json`, `.env`, PM2, and the Linux VPS workflow.
- Prefer current operational docs over historical notes.
- Keep docs factual and concise.

## Final Handoff

- Summarize what changed and where.
- Mention which checks were run.
- If deployment steps are needed, include exact VPS commands.
- If the user needs to edit `bot.config.json` or `.env`, state exactly which fields to change without exposing secrets.
