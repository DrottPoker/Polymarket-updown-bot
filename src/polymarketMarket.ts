import axios from "axios";
import { AppConfig } from "./config";
import { Direction, PolymarketMarketSelection, PolymarketOutcome } from "./types";

type GammaMarket = {
  question?: string;
  conditionId?: string;
  slug?: string;
  outcomes?: string[] | string;
  clobTokenIds?: string[] | string;
  enableOrderBook?: boolean;
  active?: boolean;
  closed?: boolean;
};

type GammaEvent = {
  title?: string;
  slug?: string;
  markets?: GammaMarket[];
};

function parseStringArray(value: string[] | string | undefined, field: string): string[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value) {
    throw new Error(`Gamma market is missing ${field}`);
  }

  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`Gamma market ${field} was not a string array`);
  }

  return parsed;
}

function outcomeForDirection(direction: Direction): PolymarketOutcome {
  return direction === "UP" ? "Up" : "Down";
}

export function buildUpDownSlug(config: AppConfig, candleOpenTime: number): string {
  const epochSeconds = Math.floor(candleOpenTime / 1000);
  return `${config.polymarketAssetSlug}-updown-${config.polymarketIntervalSlug}-${epochSeconds}`;
}

export async function findPolymarketMarketForTrade(
  config: AppConfig,
  candleOpenTime: number,
  direction: Direction
): Promise<PolymarketMarketSelection> {
  const slug = buildUpDownSlug(config, candleOpenTime);
  const response = await axios.get<GammaEvent>(`/events/slug/${slug}`, {
    baseURL: config.gammaBaseUrl,
    timeout: 10_000,
  });

  const event = response.data;
  const market = event.markets?.[0];
  if (!market) {
    throw new Error(`No Gamma market found for ${slug}`);
  }

  if (!market.conditionId) {
    throw new Error(`Gamma market ${slug} is missing conditionId`);
  }

  const outcomes = parseStringArray(market.outcomes, "outcomes");
  const tokenIds = parseStringArray(market.clobTokenIds, "clobTokenIds");
  const desiredOutcome = outcomeForDirection(direction);
  const outcomeIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === desiredOutcome.toLowerCase());

  if (outcomeIndex < 0 || !tokenIds[outcomeIndex]) {
    throw new Error(`Could not map ${desiredOutcome} to a CLOB token for ${slug}`);
  }

  return {
    slug: market.slug ?? event.slug ?? slug,
    title: market.question ?? event.title ?? slug,
    conditionId: market.conditionId,
    tokenId: tokenIds[outcomeIndex],
    outcome: desiredOutcome,
    active: market.active === true,
    closed: market.closed === true,
    enableOrderBook: market.enableOrderBook === true,
  };
}
