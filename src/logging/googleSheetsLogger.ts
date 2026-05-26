import { createSign } from "node:crypto";
import { AppConfig } from "../config/appConfig";
import { LiveOrder, OrderEvent, ResolvedPaperTrade } from "../domain/types";
import {
  buildOrderEventRow,
  buildStatsCsvValuesFromRows,
  buildTradeResultRow,
  CsvRow,
  orderEventCsvColumns,
  statsCsvColumns,
  tradeCsvColumns,
} from "./logger";

type SheetValue = string | number | boolean;

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type SpreadsheetMetadataResponse = {
  sheets?: Array<{
    properties?: {
      title?: string;
    };
  }>;
};

type ValueRangeResponse = {
  values?: Array<Array<string | number | boolean>>;
};

const sheetsScope = "https://www.googleapis.com/auth/spreadsheets";
const tokenUrl = "https://oauth2.googleapis.com/token";

function base64Url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function sheetRange(sheetName: string, range: string): string {
  const escapedSheetName = sheetName.replace(/'/g, "''");
  return `'${escapedSheetName}'!${range}`;
}

function columnName(columnCount: number): string {
  let index = columnCount;
  let name = "";

  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }

  return name;
}

function normalizeValues(values: Array<Array<string | number | boolean | null | undefined>>): SheetValue[][] {
  return values.map((row) => row.map((value) => (value === null || value === undefined ? "" : value)));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function sheetValuesToRows(values: Array<Array<string | number | boolean>>): CsvRow[] {
  if (values.length <= 1) {
    return [];
  }

  const header = values[0].map(String);
  return values.slice(1).flatMap((valuesRow) => {
    const row = header.reduce<CsvRow>((record, column, index) => {
      record[column] = valuesRow[index] === undefined ? "" : String(valuesRow[index]);
      return record;
    }, {});

    return Object.values(row).some((value) => value.trim().length > 0) ? [row] : [];
  });
}

export class GoogleSheetsLogger {
  private accessToken: { value: string; expiresAt: number } | null = null;
  private ensurePromise: Promise<void> | null = null;

  constructor(private readonly config: AppConfig) {}

  async ensureSheets(): Promise<void> {
    if (!this.ensurePromise) {
      this.ensurePromise = this.ensureSheetsInternal().catch((error) => {
        this.ensurePromise = null;
        throw error;
      });
    }

    return this.ensurePromise;
  }

  async clearLogs(): Promise<void> {
    await this.ensureSheets();
    await this.replaceValues(this.config.googleSheetsTradesSheetName, tradeCsvColumns.length, [tradeCsvColumns]);
    await this.replaceValues(this.config.googleSheetsOrderEventsSheetName, orderEventCsvColumns.length, [orderEventCsvColumns]);
    await this.refreshStats();
  }

  async appendTradeResult(trade: ResolvedPaperTrade, liveOrder?: LiveOrder | null): Promise<void> {
    await this.ensureSheets();
    const row = normalizeValues([buildTradeResultRow(trade, liveOrder)]);
    await this.appendValues(this.config.googleSheetsTradesSheetName, tradeCsvColumns.length, row);
  }

  async appendOrderEvent(event: OrderEvent): Promise<void> {
    await this.ensureSheets();
    const row = normalizeValues([buildOrderEventRow(event)]);
    await this.appendValues(this.config.googleSheetsOrderEventsSheetName, orderEventCsvColumns.length, row);
  }

  async refreshStats(): Promise<void> {
    await this.ensureSheets();
    await this.replaceValues(
      this.config.googleSheetsStatsSheetName,
      statsCsvColumns.length,
      buildStatsCsvValuesFromRows(await this.readTradeRowsFromSheet())
    );
  }

  private async ensureSheetsInternal(): Promise<void> {
    const titles = await this.getSheetTitles();
    await this.ensureSheetExists(this.config.googleSheetsTradesSheetName, titles);
    await this.ensureSheetExists(this.config.googleSheetsStatsSheetName, titles);
    await this.ensureSheetExists(this.config.googleSheetsOrderEventsSheetName, titles);
    await this.ensureHeader(this.config.googleSheetsTradesSheetName, tradeCsvColumns);
    await this.ensureHeader(this.config.googleSheetsStatsSheetName, statsCsvColumns);
    await this.ensureHeader(this.config.googleSheetsOrderEventsSheetName, orderEventCsvColumns);
  }

  private async ensureSheetExists(sheetName: string, titles: Set<string>): Promise<void> {
    if (titles.has(sheetName)) {
      return;
    }

    await this.requestJson("POST", ":batchUpdate", {
      requests: [
        {
          addSheet: {
            properties: {
              title: sheetName,
            },
          },
        },
      ],
    });
    titles.add(sheetName);
  }

  private async ensureHeader(sheetName: string, header: string[]): Promise<void> {
    const range = sheetRange(sheetName, "1:1");
    const response = await this.requestJson<ValueRangeResponse>("GET", `/values/${encodeURIComponent(range)}`);
    const existingHeader = response.values?.[0] ?? [];
    const headerMatches = header.length === existingHeader.length && header.every((column, index) => existingHeader[index] === column);
    if (headerMatches) {
      return;
    }

    await this.updateValues(sheetName, `A1:${columnName(header.length)}1`, [header]);
  }

  private async getSheetTitles(): Promise<Set<string>> {
    const metadata = await this.requestJson<SpreadsheetMetadataResponse>("GET", "?fields=sheets.properties.title");
    return new Set(
      (metadata.sheets ?? [])
        .map((sheet) => sheet.properties?.title)
        .filter((title): title is string => Boolean(title))
    );
  }

  private async readTradeRowsFromSheet(): Promise<CsvRow[]> {
    const range = sheetRange(this.config.googleSheetsTradesSheetName, `A:${columnName(tradeCsvColumns.length)}`);
    const response = await this.requestJson<ValueRangeResponse>(
      "GET",
      `/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`
    );
    return sheetValuesToRows(response.values ?? []);
  }

  private async appendValues(sheetName: string, columnCount: number, values: SheetValue[][]): Promise<void> {
    const range = sheetRange(sheetName, `A:${columnName(columnCount)}`);
    await this.requestJson("POST", `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`, {
      values,
    });
  }

  private async replaceValues(
    sheetName: string,
    columnCount: number,
    values: Array<Array<string | number | boolean | null | undefined>>
  ): Promise<void> {
    const fullColumnRange = sheetRange(sheetName, `A:${columnName(columnCount)}`);
    await this.requestJson("POST", `/values/${encodeURIComponent(fullColumnRange)}:clear`, {});

    if (values.length === 0) {
      return;
    }

    await this.updateValues(sheetName, `A1:${columnName(columnCount)}${values.length}`, normalizeValues(values));
  }

  private async updateValues(sheetName: string, range: string, values: SheetValue[][]): Promise<void> {
    const fullRange = sheetRange(sheetName, range);
    await this.requestJson("PUT", `/values/${encodeURIComponent(fullRange)}?valueInputOption=RAW`, {
      values,
    });
  }

  private async requestJson<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const accessToken = await this.getAccessToken();
    const response = await fetchWithTimeout(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.config.googleSheetsSpreadsheetId}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      this.config.googleSheetsRequestTimeoutMs
    );
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Google Sheets request failed (${response.status}): ${text.slice(0, 500)}`);
    }

    return text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
  }

  private async getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.accessToken && this.accessToken.expiresAt - 60 > now) {
      return this.accessToken.value;
    }

    const assertion = this.createJwt(now);
    const response = await fetchWithTimeout(
      tokenUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      },
      this.config.googleSheetsRequestTimeoutMs
    );
    const token = (await response.json()) as GoogleTokenResponse;

    if (!response.ok || !token.access_token) {
      const reason = token.error_description ?? token.error ?? `HTTP ${response.status}`;
      throw new Error(`Google OAuth token request failed: ${reason}`);
    }

    this.accessToken = {
      value: token.access_token,
      expiresAt: now + (token.expires_in ?? 3600),
    };
    return this.accessToken.value;
  }

  private createJwt(now: number): string {
    const header = {
      alg: "RS256",
      typ: "JWT",
    };
    const payload = {
      iss: this.config.googleServiceAccountEmail,
      scope: sheetsScope,
      aud: tokenUrl,
      exp: now + 3600,
      iat: now,
    };
    const unsignedToken = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
    const signature = createSign("RSA-SHA256").update(unsignedToken).sign(this.config.googlePrivateKey);
    return `${unsignedToken}.${base64Url(signature)}`;
  }
}
