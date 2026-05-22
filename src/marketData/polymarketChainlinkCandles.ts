import axios from "axios";
import { AppConfig } from "../config/appConfig";
import { Candle, CandleColor } from "../domain/types";
import { buildUpDownSlug } from "../polymarket/marketDiscovery";

type GammaEventMetadata = {
  priceToBeat?: number | string;
  finalPrice?: number | string;
};

type GammaEvent = {
  slug?: string;
  eventMetadata?: GammaEventMetadata | null;
};

type RtdsMessage = {
  topic?: string;
  type?: string;
  payload?: {
    data?: Array<{
      timestamp?: number;
      value?: number;
    }>;
    symbol?: string;
    timestamp?: number;
    value?: number;
  };
};

type PriceTick = {
  timestamp: number;
  value: number;
};

const sourceByKey = new Map<string, PolymarketChainlinkCandleSource>();

function getCandleColor(open: number, close: number): CandleColor {
  if (close > open) {
    return "green";
  }

  if (close < open) {
    return "red";
  }

  return "doji";
}

function buildCandle(openTime: number, intervalMs: number, open: number, high: number, low: number, close: number): Candle {
  return {
    openTime,
    closeTime: openTime + intervalMs - 1,
    open,
    high,
    low,
    close,
    color: getCandleColor(open, close),
  };
}

function parseIntervalMs(interval: string): number {
  const match = /^(\d+)(m|h)$/i.exec(interval.trim());
  if (!match) {
    throw new Error(`Polymarket Chainlink source supports minute/hour intervals, got "${interval}"`);
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "m" ? 60_000 : 3_600_000;
  return amount * multiplier;
}

function floorToInterval(timestamp: number, intervalMs: number): number {
  return Math.floor(timestamp / intervalMs) * intervalMs;
}

function toFiniteNumber(value: number | string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeGammaEvents(value: unknown): GammaEvent[] {
  if (Array.isArray(value)) {
    return value as GammaEvent[];
  }

  if (value && typeof value === "object") {
    return [value as GammaEvent];
  }

  return [];
}

function chainlinkSymbolForAsset(assetSlug: string): string {
  return `${assetSlug.toLowerCase()}/usd`;
}

function websocketStateName(socket: WebSocket | null): string {
  if (!socket) {
    return "closed";
  }

  if (socket.readyState === WebSocket.CONNECTING) {
    return "connecting";
  }

  if (socket.readyState === WebSocket.OPEN) {
    return "open";
  }

  if (socket.readyState === WebSocket.CLOSING) {
    return "closing";
  }

  return "closed";
}

export async function fetchPolymarketChainlinkCandles(config: AppConfig, limit = 10): Promise<Candle[]> {
  const key = `${config.polymarketAssetSlug}:${config.polymarketIntervalSlug}:${config.interval}`;
  let source = sourceByKey.get(key);
  if (!source) {
    source = new PolymarketChainlinkCandleSource(config);
    sourceByKey.set(key, source);
  }

  return source.fetchCandles(limit);
}

export function closePolymarketChainlinkCandleSources(): void {
  for (const source of sourceByKey.values()) {
    source.close();
  }

  sourceByKey.clear();
}

class PolymarketChainlinkCandleSource {
  private readonly intervalMs: number;
  private readonly symbol: string;
  private readonly historicalCandles = new Map<number, Candle>();
  private readonly historicalOpenPrices = new Map<number, number>();
  private readonly liveCandles = new Map<number, Candle>();
  private readonly metadataMisses = new Map<number, number>();
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private firstPriceResolvers: Array<(tick: PriceTick) => void> = [];
  private firstPriceRejecters: Array<(error: Error) => void> = [];
  private lastTick: PriceTick | null = null;
  private closedByOwner = false;

  constructor(private readonly config: AppConfig) {
    this.intervalMs = parseIntervalMs(config.interval);
    this.symbol = chainlinkSymbolForAsset(config.polymarketAssetSlug);
  }

  close(): void {
    this.closedByOwner = true;
    this.clearReconnectTimer();
    this.clearPingTimer();
    this.rejectFirstPriceWaiters(new Error("Polymarket Chainlink candle source closed"));

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  async fetchCandles(limit: number): Promise<Candle[]> {
    this.ensureSocket();
    await this.waitForFirstPrice();

    const currentOpenTime = floorToInterval(Date.now(), this.intervalMs);
    await this.hydrateHistoricalCandles(currentOpenTime, limit - 1);

    const closedCandles = this.getContiguousClosedCandles(currentOpenTime, limit - 1);
    const currentCandle = this.getCurrentCandle(currentOpenTime, closedCandles[closedCandles.length - 1]);
    return [...closedCandles, currentCandle];
  }

  private ensureSocket(): void {
    const state = websocketStateName(this.socket);
    if (state === "open" || state === "connecting") {
      return;
    }

    this.closedByOwner = false;
    this.clearReconnectTimer();
    this.socket = new WebSocket(this.config.polymarketRtdsUrl);
    this.socket.addEventListener("open", () => this.handleOpen());
    this.socket.addEventListener("message", (event) => this.handleMessage(event.data));
    this.socket.addEventListener("close", () => this.handleClose());
    this.socket.addEventListener("error", () => this.handleError());
  }

  private handleOpen(): void {
    this.socket?.send(
      JSON.stringify({
        action: "subscribe",
        subscriptions: [
          {
            topic: "crypto_prices_chainlink",
            type: "*",
            filters: JSON.stringify({ symbol: this.symbol }),
          },
        ],
      })
    );

    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send("PING");
      }
    }, 5_000);
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }

    let message: RtdsMessage;
    try {
      message = JSON.parse(data) as RtdsMessage;
    } catch {
      return;
    }

    if (message.topic !== "crypto_prices_chainlink") {
      return;
    }

    const payload = message.payload;
    if (Array.isArray(payload?.data)) {
      for (const tick of payload.data) {
        if (Number.isFinite(tick.timestamp) && Number.isFinite(tick.value)) {
          this.recordTick({
            timestamp: tick.timestamp as number,
            value: tick.value as number,
          });
        }
      }
      return;
    }

    if (message.type !== "update") {
      return;
    }

    if (payload?.symbol?.toLowerCase() !== this.symbol) {
      return;
    }

    const timestamp = payload.timestamp;
    const value = payload.value;
    if (!Number.isFinite(timestamp) || !Number.isFinite(value)) {
      return;
    }

    this.recordTick({
      timestamp: timestamp as number,
      value: value as number,
    });
  }

  private handleClose(): void {
    this.clearPingTimer();
    if (!this.closedByOwner) {
      this.scheduleReconnect();
    }
  }

  private handleError(): void {
    if (!this.lastTick) {
      this.rejectFirstPriceWaiters(new Error("Polymarket RTDS WebSocket error before first Chainlink price"));
    }

    if (!this.closedByOwner) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.socket = null;
      this.ensureSocket();
    }, 2_000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private waitForFirstPrice(): Promise<PriceTick> {
    if (this.lastTick) {
      return Promise.resolve(this.lastTick);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.firstPriceResolvers = this.firstPriceResolvers.filter((resolver) => resolver !== resolve);
        this.firstPriceRejecters = this.firstPriceRejecters.filter((rejecter) => rejecter !== reject);
        reject(new Error(`No Polymarket Chainlink RTDS price received within ${this.config.polymarketRtdsFirstPriceTimeoutMs}ms`));
      }, this.config.polymarketRtdsFirstPriceTimeoutMs);

      this.firstPriceResolvers.push((tick) => {
        clearTimeout(timeout);
        resolve(tick);
      });
      this.firstPriceRejecters.push((error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private resolveFirstPriceWaiters(tick: PriceTick): void {
    const resolvers = this.firstPriceResolvers;
    this.firstPriceResolvers = [];
    this.firstPriceRejecters = [];
    for (const resolve of resolvers) {
      resolve(tick);
    }
  }

  private rejectFirstPriceWaiters(error: Error): void {
    const rejecters = this.firstPriceRejecters;
    this.firstPriceResolvers = [];
    this.firstPriceRejecters = [];
    for (const reject of rejecters) {
      reject(error);
    }
  }

  private recordTick(tick: PriceTick): void {
    this.lastTick = tick;
    this.resolveFirstPriceWaiters(tick);

    const openTime = floorToInterval(tick.timestamp, this.intervalMs);
    const existing = this.liveCandles.get(openTime);
    if (existing) {
      this.liveCandles.set(openTime, {
        ...existing,
        high: Math.max(existing.high, tick.value),
        low: Math.min(existing.low, tick.value),
        close: tick.value,
        color: getCandleColor(existing.open, tick.value),
      });
    } else {
      const previousOpenTime = openTime - this.intervalMs;
      const previous = this.liveCandles.get(previousOpenTime);
      if (previous) {
        this.liveCandles.set(previousOpenTime, {
          ...previous,
          high: Math.max(previous.high, tick.value),
          low: Math.min(previous.low, tick.value),
          close: tick.value,
          color: getCandleColor(previous.open, tick.value),
        });
      }

      this.liveCandles.set(openTime, buildCandle(openTime, this.intervalMs, tick.value, tick.value, tick.value, tick.value));
    }

    this.pruneLiveCandles(openTime);
  }

  private pruneLiveCandles(currentOpenTime: number): void {
    const oldestAllowed = currentOpenTime - this.intervalMs * (this.config.candleLimit + 20);
    for (const openTime of this.liveCandles.keys()) {
      if (openTime < oldestAllowed) {
        this.liveCandles.delete(openTime);
      }
    }
  }

  private async hydrateHistoricalCandles(currentOpenTime: number, closedLimit: number): Promise<void> {
    const requiredOpenTimes: number[] = [];
    for (let index = closedLimit; index >= 1; index -= 1) {
      requiredOpenTimes.push(currentOpenTime - index * this.intervalMs);
    }

    const now = Date.now();
    const missingOpenTimes = requiredOpenTimes.filter((openTime) => {
      if (this.historicalCandles.has(openTime) || this.liveCandles.has(openTime)) {
        return false;
      }

      const lastMiss = this.metadataMisses.get(openTime);
      return !lastMiss || now - lastMiss > 30_000;
    });

    for (let index = 0; index < missingOpenTimes.length; index += this.config.polymarketHistoryBatchSize) {
      const chunk = missingOpenTimes.slice(index, index + this.config.polymarketHistoryBatchSize);
      await this.fetchHistoricalChunk(chunk);
    }
  }

  private async fetchHistoricalChunk(openTimes: number[]): Promise<void> {
    if (openTimes.length === 0) {
      return;
    }

    const requestOpenTimes = Array.from(new Set(openTimes.flatMap((openTime) => [openTime, openTime + this.intervalMs])));
    const params = new URLSearchParams();
    params.set("limit", String(requestOpenTimes.length));
    for (const openTime of requestOpenTimes) {
      params.append("slug", buildUpDownSlug(this.config, openTime));
    }

    const response = await axios.get<unknown>(`/events?${params.toString()}`, {
      baseURL: this.config.gammaBaseUrl,
      timeout: 15_000,
    });

    const events = normalizeGammaEvents(response.data);
    const eventByOpenTime = new Map<number, GammaEvent>();
    for (const event of events) {
      if (!event.slug) {
        continue;
      }

      const openTime = this.openTimeFromSlug(event.slug);
      if (openTime !== null) {
        eventByOpenTime.set(openTime, event);
        const open = toFiniteNumber(event.eventMetadata?.priceToBeat);
        if (open !== null) {
          this.historicalOpenPrices.set(openTime, open);
        }
      }
    }

    const foundOpenTimes = new Set<number>();
    for (const openTime of openTimes) {
      const candle = this.candleFromGammaEvents(openTime, eventByOpenTime.get(openTime), eventByOpenTime.get(openTime + this.intervalMs));
      if (candle) {
        this.historicalCandles.set(candle.openTime, candle);
        this.metadataMisses.delete(candle.openTime);
        foundOpenTimes.add(candle.openTime);
      }
    }

    const now = Date.now();
    for (const openTime of openTimes) {
      if (!foundOpenTimes.has(openTime)) {
        this.metadataMisses.set(openTime, now);
      }
    }
  }

  private candleFromGammaEvents(openTime: number, event: GammaEvent | undefined, nextEvent: GammaEvent | undefined): Candle | null {
    const open = toFiniteNumber(event?.eventMetadata?.priceToBeat);
    const close =
      toFiniteNumber(event?.eventMetadata?.finalPrice) ?? toFiniteNumber(nextEvent?.eventMetadata?.priceToBeat);
    if (open === null || close === null) {
      return null;
    }

    return buildCandle(openTime, this.intervalMs, open, Math.max(open, close), Math.min(open, close), close);
  }

  private openTimeFromSlug(slug: string): number | null {
    const parts = slug.split("-");
    const epochSeconds = Number(parts[parts.length - 1]);
    if (!Number.isInteger(epochSeconds) || epochSeconds <= 0) {
      return null;
    }

    return epochSeconds * 1000;
  }

  private getContiguousClosedCandles(currentOpenTime: number, closedLimit: number): Candle[] {
    const candles: Candle[] = [];
    for (let index = closedLimit; index >= 1; index -= 1) {
      const openTime = currentOpenTime - index * this.intervalMs;
      const candle = this.liveCandles.get(openTime) ?? this.historicalCandles.get(openTime);
      const resolvedCandle = candle ?? this.buildCandleFromAdjacentOpen(openTime);
      if (!resolvedCandle) {
        throw new Error(
          `Missing Polymarket Chainlink candle for ${new Date(openTime).toISOString()}; waiting for Gamma metadata or RTDS live data`
        );
      }

      candles.push(resolvedCandle);
    }

    return candles;
  }

  private buildCandleFromAdjacentOpen(openTime: number): Candle | null {
    const open = this.historicalOpenPrices.get(openTime);
    const nextCandle = this.liveCandles.get(openTime + this.intervalMs) ?? this.historicalCandles.get(openTime + this.intervalMs);
    if (open === undefined || !nextCandle) {
      return null;
    }

    const candle = buildCandle(openTime, this.intervalMs, open, Math.max(open, nextCandle.open), Math.min(open, nextCandle.open), nextCandle.open);
    this.historicalCandles.set(openTime, candle);
    return candle;
  }

  private getCurrentCandle(currentOpenTime: number, previousClosedCandle: Candle | undefined): Candle {
    const liveCandle = this.liveCandles.get(currentOpenTime);
    if (liveCandle) {
      return liveCandle;
    }

    const fallbackPrice = this.lastTick?.value ?? previousClosedCandle?.close;
    if (!Number.isFinite(fallbackPrice)) {
      throw new Error("Cannot build current Polymarket Chainlink candle before a live price is available");
    }

    const open = previousClosedCandle?.close ?? (fallbackPrice as number);
    const close = fallbackPrice as number;
    return buildCandle(currentOpenTime, this.intervalMs, open, Math.max(open, close), Math.min(open, close), close);
  }
}
