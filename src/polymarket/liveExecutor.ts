import { Chain, ClobClient, OrderType, Side, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import type { ApiKeyCreds, OpenOrder, OrderResponse, TickSize, Trade } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AppConfig } from "../config/appConfig";
import { LiveOrder, PaperTrade } from "../domain/types";
import { findPolymarketMarketForTrade } from "./marketDiscovery";

type OrderDetails = Pick<OpenOrder, "status" | "associate_trades">;

function toPrivateKey(value: string): `0x${string}` {
  if (!value.startsWith("0x")) {
    throw new Error("POLYMARKET_PRIVATE_KEY must start with 0x");
  }

  return value as `0x${string}`;
}

function toChain(chainId: number): Chain {
  if (chainId === Chain.POLYGON || chainId === Chain.AMOY) {
    return chainId;
  }

  throw new Error(`Unsupported Polymarket chain id ${chainId}`);
}

function toSignatureType(value: number): SignatureTypeV2 {
  if (value === SignatureTypeV2.EOA) {
    return SignatureTypeV2.EOA;
  }

  if (value === SignatureTypeV2.POLY_PROXY) {
    return SignatureTypeV2.POLY_PROXY;
  }

  if (value === SignatureTypeV2.POLY_GNOSIS_SAFE) {
    return SignatureTypeV2.POLY_GNOSIS_SAFE;
  }

  if (value === SignatureTypeV2.POLY_1271) {
    return SignatureTypeV2.POLY_1271;
  }

  throw new Error(`Unsupported Polymarket signature type ${value}`);
}

function getOrderId(response: unknown): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const maybeOrder = response as Partial<OrderResponse> & { orderId?: string };
  return maybeOrder.orderID ?? maybeOrder.orderId;
}

function getOrderStatus(response: unknown): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const maybeOrder = response as Partial<OrderResponse>;
  return maybeOrder.status;
}

function parsePositiveNumber(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function statusBlocksFill(status: string | undefined): boolean {
  const normalized = status?.toLowerCase() ?? "";
  return ["fail", "reject", "cancel", "error", "invalid", "pending", "retry"].some((blockedStatus) =>
    normalized.includes(blockedStatus)
  );
}

function responseTradeIds(response: unknown): string[] {
  if (!response || typeof response !== "object") {
    return [];
  }

  const maybeOrder = response as Partial<OrderResponse>;
  return maybeOrder.tradeIDs ?? [];
}

function orderDetailsTradeIds(order: OrderDetails | null): string[] {
  if (!order || statusBlocksFill(order.status)) {
    return [];
  }

  return order.associate_trades ?? [];
}

function tradeCanCountAsFill(trade: Trade): boolean {
  return !statusBlocksFill(trade.status) && !(trade.err_msg && trade.err_msg.trim().length > 0);
}

function tradeFilledSizeForOrder(order: LiveOrder, trade: Trade): number {
  if (!tradeCanCountAsFill(trade)) {
    return 0;
  }

  if (trade.taker_order_id === order.orderId) {
    return parsePositiveNumber(trade.size);
  }

  return (trade.maker_orders ?? [])
    .filter((makerOrder) => makerOrder.order_id === order.orderId)
    .reduce((filledSize, makerOrder) => filledSize + parsePositiveNumber(makerOrder.matched_amount), 0);
}

function isFullyFilled(order: LiveOrder, filledSize: number): boolean {
  return filledSize >= order.size * 0.999;
}

function getTickSize(value: string): TickSize {
  if (value === "0.1" || value === "0.01" || value === "0.001" || value === "0.0001") {
    return value;
  }

  throw new Error(`Unsupported market tick size ${value}`);
}

export class PolymarketLiveExecutor {
  private clientPromise: Promise<ClobClient> | null = null;
  private readonly publicClient: ClobClient;

  constructor(private readonly config: AppConfig) {
    this.publicClient = new ClobClient({
      host: config.clobHost,
      chain: toChain(config.polymarketChainId),
      throwOnError: true,
    });
  }

  async dryRunLimitBuy(trade: PaperTrade): Promise<LiveOrder> {
    const market = await findPolymarketMarketForTrade(this.config, trade.candleOpenTime, trade.direction);
    if (!market.active || market.closed || !market.enableOrderBook) {
      throw new Error(
        `Polymarket market ${market.slug} is not tradable (active=${market.active}, closed=${market.closed}, orderbook=${market.enableOrderBook})`
      );
    }

    const book = await this.publicClient.getOrderBook(market.tokenId);
    const tickSize = getTickSize(book.tick_size);
    const price = trade.entryCents / 100;
    const minOrderSize = Number(book.min_order_size);

    if (Number.isFinite(minOrderSize) && trade.shares < minOrderSize) {
      throw new Error(`Order size ${trade.shares.toFixed(4)} is below market minimum ${minOrderSize}`);
    }

    return {
      dryRun: true,
      marketSlug: market.slug,
      conditionId: market.conditionId,
      tokenId: market.tokenId,
      outcome: market.outcome,
      price,
      size: trade.shares,
      tickSize,
      minOrderSize: book.min_order_size,
      negRisk: book.neg_risk,
      status: "DRY_RUN",
      postedAt: Date.now(),
      cancelAt: trade.candleOpenTime + this.config.tradeWindowSeconds * 1000,
      response: {
        wouldPostOrder: {
          tokenID: market.tokenId,
          price,
          side: Side.BUY,
          size: trade.shares,
          orderType: OrderType.GTC,
          options: {
            tickSize,
            negRisk: book.neg_risk,
          },
        },
      },
      filled: false,
      filledSize: 0,
      canceled: false,
    };
  }

  async placeLimitBuy(trade: PaperTrade): Promise<LiveOrder> {
    const market = await findPolymarketMarketForTrade(this.config, trade.candleOpenTime, trade.direction);
    if (!market.active || market.closed || !market.enableOrderBook) {
      throw new Error(
        `Polymarket market ${market.slug} is not tradable (active=${market.active}, closed=${market.closed}, orderbook=${market.enableOrderBook})`
      );
    }

    const book = await this.publicClient.getOrderBook(market.tokenId);
    const tickSize = getTickSize(book.tick_size);
    const price = trade.entryCents / 100;
    const minOrderSize = Number(book.min_order_size);

    if (Number.isFinite(minOrderSize) && trade.shares < minOrderSize) {
      throw new Error(`Order size ${trade.shares.toFixed(4)} is below market minimum ${minOrderSize}`);
    }

    const client = await this.getTradingClient();
    const response = await client.createAndPostOrder(
      {
        tokenID: market.tokenId,
        price,
        side: Side.BUY,
        size: trade.shares,
      },
      {
        tickSize,
        negRisk: book.neg_risk,
      },
      OrderType.GTC
    );
    const orderId = getOrderId(response);
    if (!orderId) {
      throw new Error("Polymarket order response did not include an order id");
    }

    return {
      dryRun: false,
      marketSlug: market.slug,
      conditionId: market.conditionId,
      tokenId: market.tokenId,
      outcome: market.outcome,
      price,
      size: trade.shares,
      tickSize,
      minOrderSize: book.min_order_size,
      negRisk: book.neg_risk,
      orderId,
      status: getOrderStatus(response),
      postedAt: Date.now(),
      cancelAt: trade.candleOpenTime + this.config.tradeWindowSeconds * 1000,
      response,
      filled: false,
      filledSize: 0,
      canceled: false,
    };
  }

  async cancelIfDue(order: LiveOrder, now: number): Promise<LiveOrder> {
    if (order.canceled || order.filled || !order.orderId || now < order.cancelAt) {
      return order;
    }

    const filledSize = await this.getFilledSizeOrZero(order);
    if (isFullyFilled(order, filledSize)) {
      return {
        ...order,
        filledSize,
        filled: true,
      };
    }

    return this.cancelOrder(order);
  }

  async cancelOrder(order: LiveOrder): Promise<LiveOrder> {
    if (order.canceled || order.filled || !order.orderId) {
      return order;
    }

    const filledSizeBeforeCancel = await this.getFilledSizeOrZero(order);
    if (isFullyFilled(order, filledSizeBeforeCancel)) {
      return {
        ...order,
        filledSize: filledSizeBeforeCancel,
        filled: true,
      };
    }

    const client = await this.getTradingClient();
    const cancelResponse = await client.cancelOrder({ orderID: order.orderId });
    const filledSizeAfterCancel = await this.getFilledSizeOrZero(order);
    return {
      ...order,
      filled: order.filled || isFullyFilled(order, filledSizeAfterCancel),
      filledSize: Math.max(filledSizeBeforeCancel, filledSizeAfterCancel),
      canceled: true,
      cancelResponse,
    };
  }

  async refreshFillStatus(order: LiveOrder): Promise<LiveOrder> {
    if (order.filled || !order.orderId) {
      return order;
    }

    const filledSize = await this.getFilledSizeOrZero(order);
    return {
      ...order,
      filled: isFullyFilled(order, filledSize),
      filledSize,
    };
  }

  private async getTradingClient(): Promise<ClobClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.createTradingClient();
    }

    return this.clientPromise;
  }

  private async createTradingClient(): Promise<ClobClient> {
    const chain = toChain(this.config.polymarketChainId);
    const account = privateKeyToAccount(toPrivateKey(this.config.polymarketPrivateKey));
    const signer = createWalletClient({
      account,
      transport: http(this.config.polygonRpcUrl),
    });
    const signatureType = toSignatureType(this.config.polymarketSignatureType);

    const configuredCreds = this.getConfiguredCreds();
    const creds =
      configuredCreds ??
      (await new ClobClient({
        host: this.config.clobHost,
        chain,
        signer,
        // createOrDeriveApiKey relies on create failures returning a response so it can derive existing keys.
        throwOnError: false,
      }).createOrDeriveApiKey());

    return new ClobClient({
      host: this.config.clobHost,
      chain,
      signer,
      creds,
      signatureType,
      funderAddress: this.config.polymarketFunderAddress,
      throwOnError: true,
    });
  }

  private getConfiguredCreds(): ApiKeyCreds | null {
    if (!this.config.clobApiKey || !this.config.clobSecret || !this.config.clobPassphrase) {
      return null;
    }

    return {
      key: this.config.clobApiKey,
      secret: this.config.clobSecret,
      passphrase: this.config.clobPassphrase,
    };
  }

  private async getFilledSize(order: LiveOrder): Promise<number> {
    if (!order.orderId) {
      return 0;
    }

    const client = await this.getTradingClient();
    const tradeIds = new Set(responseTradeIds(order.response));
    try {
      const orderDetails = (await client.getOrder(order.orderId)) as OrderDetails | null;
      orderDetailsTradeIds(orderDetails).forEach((tradeId) => tradeIds.add(tradeId));
    } catch {
      // CLOB may stop returning an order after cancel/expiry. Trade lookup below is the fill source.
    }

    const tradesById = new Map<string, Trade>();
    const assetTrades = await client.getTrades({ asset_id: order.tokenId }, true);
    assetTrades.forEach((trade) => tradesById.set(trade.id, trade));

    for (const tradeId of tradeIds) {
      if (tradesById.has(tradeId)) {
        continue;
      }

      const trades = await client.getTrades({ id: tradeId }, true);
      trades.forEach((trade) => tradesById.set(trade.id, trade));
    }

    return Array.from(tradesById.values()).reduce(
      (filledSize, trade) => filledSize + tradeFilledSizeForOrder(order, trade),
      0
    );
  }

  private async getFilledSizeOrZero(order: LiveOrder): Promise<number> {
    try {
      return await this.getFilledSize(order);
    } catch {
      return 0;
    }
  }
}
