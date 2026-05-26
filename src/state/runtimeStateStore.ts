import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AppConfig } from "../config/appConfig";
import { LiveOrder, PaperTrade } from "../domain/types";
import { RuntimeRiskSnapshot } from "../trading/riskManager";

export type PendingLiveTradeState = {
  trade: PaperTrade;
  liveOrder: LiveOrder;
  earlyEntryTargetOpenTime: number | null;
  earlyEntryFinalValidationDone: boolean;
};

export type RuntimeState = {
  version: 1;
  updatedAt: string;
  risk: RuntimeRiskSnapshot | null;
  pendingLiveTrade: PendingLiveTradeState | null;
};

const emptyState = (): RuntimeState => ({
  version: 1,
  updatedAt: new Date().toISOString(),
  risk: null,
  pendingLiveTrade: null,
});

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRuntimeState(value: unknown): RuntimeState {
  if (!isObject(value)) {
    return emptyState();
  }

  const state = value as Partial<RuntimeState>;
  return {
    version: 1,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : new Date().toISOString(),
    risk: isObject(state.risk) ? (state.risk as RuntimeRiskSnapshot) : null,
    pendingLiveTrade: isObject(state.pendingLiveTrade) ? (state.pendingLiveTrade as PendingLiveTradeState) : null,
  };
}

export class RuntimeStateStore {
  private readonly path: string;

  constructor(config: AppConfig) {
    this.path = resolve(config.runtimeStateFile);
  }

  load(): RuntimeState {
    if (!existsSync(this.path)) {
      return emptyState();
    }

    const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    return normalizeRuntimeState(parsed);
  }

  save(state: RuntimeState): void {
    const nextState: RuntimeState = {
      ...state,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, this.path);
  }
}
