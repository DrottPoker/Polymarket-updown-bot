import { Chain, ClobClient, OrderType, Side, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import type { ApiKeyCreds, FeeDetails, OpenOrder, OrderResponse, TickSize, Trade } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AppConfig } from "../config/appConfig";
import { LiveOrder, PaperTrade } from "../domain/types";
import { findPolymarketMarketForTrade } from "./marketDiscovery";

type OrderDetails = Pick<OpenOrder, "status" | "associate_trades">;

type LiveFillDetails = {
  filledSize: number;
  feeUsd: number;
};

type FillRole = "TAKER" | "MAKER";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function calculateFillFeeUsd(fillSize: number, price: number, feeDetails: FeeDetails | null, role: FillRole): number {
  if (!feeDetails || fillSize <= 0 || price <= 0 || price >= 1) {
    return 0;
  }

  if (role === "MAKER" && feeDetails.to === true) {
    return 0;
  }

  const rate = Number(feeDetails.r ?? 0);
  const exponent = Number(feeDetails.e ?? 1);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(exponent) || exponent < 0) {
    return 0;
  }

  return fillSize * rate * Math.pow(price * (1 - price), exponent);
}

function tradeFeeForOrder(order: LiveOrder, trade: Trade, feeDetails: FeeDetails | null): number {
  if (!tradeCanCountAsFill(trade)) {
    return 0;
  }

  if (trade.taker_order_id === order.orderId) {
    return calculateFillFeeUsd(
      parsePositiveNumber(trade.size),
      parsePositiveNumber(trade.price),
      feeDetails,
      "TAKER"
    );
  }

  return (trade.maker_orders ?? [])
    .filter((makerOrder) => makerOrder.order_id === order.orderId)
    .reduce(
      (feeUsd, makerOrder) =>
        feeUsd +
        calculateFillFeeUsd(
          parsePositiveNumber(makerOrder.matched_amount),
          parsePositiveNumber(makerOrder.price),
          feeDetails,
          "MAKER"
        ),
      0
    );
}

function normalizeFilledSize(order: LiveOrder, filledSize: number, toleranceShares: number): number {
  const boundedFilledSize = Math.min(Math.max(filledSize, 0), order.size);
  return order.size - boundedFilledSize <= toleranceShares ? order.size : boundedFilledSize;
}

function isFullyFilled(order: LiveOrder, filledSize: number, toleranceShares: number): boolean {
  return normalizeFilledSize(order, filledSize, toleranceShares) >= order.size;
}

function getTickSize(value: string): TickSize {
  if (value === "0.1" || value === "0.01" || value === "0.001" || value === "0.0001") {
    return value;
  }

  throw new Error(`Unsupported market tick size ${value}`);
}

function assertPriceMatchesTick(price: number, tickSize: TickSize): void {
  const tick = Number(tickSize);
  const ticks = price / tick;
  if (Math.abs(ticks - Math.round(ticks)) > 1e-9) {
    throw new Error(`Entry price ${price.toFixed(4)} does not align with market tick size ${tickSize}`);
  }
}

export class PolymarketLiveExecutor {
  private clientPromise: Promise<ClobClient> | null = null;
  private readonly feeDetailsByConditionId = new Map<string, FeeDetails | null>();
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
    assertPriceMatchesTick(price, tickSize);
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
      fillStatus: "known",
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
    assertPriceMatchesTick(price, tickSize);
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
      fillStatus: "known",
      canceled: false,
    };
  }

  async cancelIfDue(order: LiveOrder, now: number): Promise<LiveOrder> {
    if (order.canceled || order.filled || !order.orderId || now < order.cancelAt) {
      return order;
    }

    const refreshedOrder = await this.refreshFillStatus(order);
    if (refreshedOrder.filled) {
      return refreshedOrder;
    }

    return this.cancelOrder(refreshedOrder);
  }

  async cancelOrder(order: LiveOrder): Promise<LiveOrder> {
    if (order.canceled || order.filled || !order.orderId) {
      return order;
    }

    const refreshedBeforeCancel = await this.refreshFillStatus(order);
    if (refreshedBeforeCancel.filled) {
      return refreshedBeforeCancel;
    }

    const client = await this.getTradingClient();
    const cancelResponse = await client.cancelOrder({ orderID: order.orderId });
    const canceledOrder = {
      ...refreshedBeforeCancel,
      canceled: true,
      cancelResponse,
    };
    const refreshedAfterCancel = await this.refreshFillStatus(canceledOrder);
    return {
      ...refreshedAfterCancel,
      canceled: true,
      cancelResponse,
    };
  }

  async refreshFillStatus(order: LiveOrder): Promise<LiveOrder> {
    if ((order.filled && order.feeUsd !== undefined) || !order.orderId) {
      return order;
    }

    try {
      const fillDetails = await this.getFillDetails(order);
      const filledSize = fillDetails.filledSize;
      const normalizedFilledSize = normalizeFilledSize(order, filledSize, this.config.liveFullFillToleranceShares);
      return {
        ...order,
        filled: isFullyFilled(order, filledSize, this.config.liveFullFillToleranceShares),
        filledSize: normalizedFilledSize,
        feeUsd: fillDetails.feeUsd,
        fillStatus: "known",
        fillError: undefined,
      };
    } catch (error) {
      return {
        ...order,
        fillStatus: "unknown",
        fillError: errorMessage(error),
      };
    }
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

  private async getFeeDetails(conditionId: string): Promise<FeeDetails | null> {
    if (this.feeDetailsByConditionId.has(conditionId)) {
      return this.feeDetailsByConditionId.get(conditionId) ?? null;
    }

    const marketInfo = await this.publicClient.getClobMarketInfo(conditionId);
    const feeDetails = marketInfo.fd ?? null;
    this.feeDetailsByConditionId.set(conditionId, feeDetails);
    return feeDetails;
  }

  private async getFillDetails(order: LiveOrder): Promise<LiveFillDetails> {
    if (!order.orderId) {
      return {
        filledSize: 0,
        feeUsd: 0,
      };
    }

    const client = await this.getTradingClient();
    const feeDetails = await this.getFeeDetails(order.conditionId);
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

    return Array.from(tradesById.values()).reduce<LiveFillDetails>(
      (details, trade) => ({
        filledSize: details.filledSize + tradeFilledSizeForOrder(order, trade),
        feeUsd: details.feeUsd + tradeFeeForOrder(order, trade, feeDetails),
      }),
      {
        filledSize: 0,
        feeUsd: 0,
      }
    );
  }

}
