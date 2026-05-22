import axios from "axios";
import { AppConfig } from "../config/appConfig";
import { Candle, CandleColor } from "../domain/types";
import { fetchPolymarketChainlinkCandles } from "./polymarketChainlinkCandles";

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string
];

function getCandleColor(open: number, close: number): CandleColor {
  if (close > open) {
    return "green";
  }

  if (close < open) {
    return "red";
  }

  return "doji";
}

function parseNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Binance kline ${field}: ${value}`);
  }

  return parsed;
}

function isBinanceKline(value: unknown): value is BinanceKline {
  return Array.isArray(value) && value.length >= 12;
}

export function parseBinanceKline(value: unknown): Candle {
  if (!isBinanceKline(value)) {
    throw new Error("Unexpected Binance kline response shape");
  }

  const open = parseNumber(value[1], "open");
  const high = parseNumber(value[2], "high");
  const low = parseNumber(value[3], "low");
  const close = parseNumber(value[4], "close");

  return {
    openTime: value[0],
    closeTime: value[6],
    open,
    high,
    low,
    close,
    color: getCandleColor(open, close),
  };
}

async function fetchBinanceCandles(config: AppConfig, limit = 10): Promise<Candle[]> {
  const response = await axios.get<unknown[]>("/api/v3/klines", {
    baseURL: config.binanceBaseUrl,
    params: {
      symbol: config.symbol,
      interval: config.interval,
      limit,
    },
    timeout: 10_000,
  });

  if (!Array.isArray(response.data)) {
    throw new Error("Unexpected Binance klines response");
  }

  return response.data.map(parseBinanceKline).sort((a, b) => a.openTime - b.openTime);
}

export async function fetchCandles(config: AppConfig, limit = 10): Promise<Candle[]> {
  if (config.priceSource === "polymarket_chainlink") {
    return fetchPolymarketChainlinkCandles(config, limit);
  }

  return fetchBinanceCandles(config, limit);
}
