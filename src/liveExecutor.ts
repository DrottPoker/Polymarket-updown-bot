import {
  ApiKeyCreds,
  Chain,
  ClobClient,
  OrderResponse,
  OrderType,
  Side,
  SignatureTypeV2,
  TickSize,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AppConfig } from "./config";
import { findPolymarketMarketForTrade } from "./polymarketMarket";
import { LiveOrder, PaperTrade } from "./types";

type OrderDetails = {
  status?: string;
  size_matched?: string;
  matched_amount?: string;
  associate_trades?: string[];
};

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

function responseHasFill(response: unknown): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }

  const maybeOrder = response as Partial<OrderResponse>;
  const status = maybeOrder.status?.toLowerCase();
  return Boolean(maybeOrder.tradeIDs?.length) || status === "matched" || status === "filled";
}

function orderDetailsHasFill(order: OrderDetails | null): boolean {
  if (!order) {
    return false;
  }

  const status = order.status?.toLowerCase();
  const matchedSize = Number(order.size_matched ?? order.matched_amount ?? 0);
  return (
    status === "matched" ||
    status === "filled" ||
    (Number.isFinite(matchedSize) && matchedSize > 0) ||
    Boolean(order.associate_trades?.length)
  );
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
      filled: responseHasFill(response),
      canceled: false,
    };
  }

  async cancelIfDue(order: LiveOrder, now: number): Promise<LiveOrder> {
    if (order.canceled || order.filled || !order.orderId || now < order.cancelAt) {
      return order;
    }

    return this.cancelOrder(order);
  }

  async cancelOrder(order: LiveOrder): Promise<LiveOrder> {
    if (order.canceled || order.filled || !order.orderId) {
      return order;
    }

    const client = await this.getTradingClient();
    const cancelResponse = await client.cancelOrder({ orderID: order.orderId });
    return {
      ...order,
      filled: order.filled || (await this.hasFill(order)),
      canceled: true,
      cancelResponse,
    };
  }

  async refreshFillStatus(order: LiveOrder): Promise<LiveOrder> {
    if (order.filled || !order.orderId) {
      return order;
    }

    return {
      ...order,
      filled: await this.hasFill(order),
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

  private async hasFill(order: LiveOrder): Promise<boolean> {
    if (!order.orderId) {
      return false;
    }

    const client = await this.getTradingClient();
    try {
      const orderDetails = (await client.getOrder(order.orderId)) as OrderDetails | null;
      if (orderDetailsHasFill(orderDetails)) {
        return true;
      }
    } catch {
      // Fall back to trade search below. CLOB may stop returning an order after cancel/expiry.
    }

    const trades = await client.getTrades({ asset_id: order.tokenId }, true);
    return trades.some(
      (trade) =>
        trade.taker_order_id === order.orderId ||
        trade.maker_orders.some((makerOrder) => makerOrder.order_id === order.orderId)
    );
  }
}
