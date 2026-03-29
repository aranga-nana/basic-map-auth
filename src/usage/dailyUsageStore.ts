import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const USAGE_STORE_PATH = path.join(process.cwd(), ".copilot-usage.json");

type ModelUsage = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type SessionUsageSummary = {
  premiumRequests: number;
  models: Record<string, ModelUsage>;
};

type DailyUsageSnapshot = SessionUsageSummary & {
  date: string;
  updatedAt: string;
};

type UsageStore = {
  days: Record<string, DailyUsageSnapshot>;
};

type ShutdownUsageEventData = {
  totalPremiumRequests: number;
  modelMetrics: Record<string, {
    requests: { count: number };
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
  }>;
};

function emptySummary(): SessionUsageSummary {
  return {
    premiumRequests: 0,
    models: {}
  };
}

function emptyDailySnapshot(date: string): DailyUsageSnapshot {
  return {
    date,
    updatedAt: new Date().toISOString(),
    ...emptySummary()
  };
}

async function readUsageStore(): Promise<UsageStore> {
  try {
    const raw = await readFile(USAGE_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<UsageStore>;
    return {
      days: parsed.days ?? {}
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { days: {} };
    }

    throw error;
  }
}

async function writeUsageStore(store: UsageStore) {
  await writeFile(USAGE_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function mergeModelUsage(current: ModelUsage | undefined, incoming: ModelUsage): ModelUsage {
  return {
    requests: (current?.requests ?? 0) + incoming.requests,
    inputTokens: (current?.inputTokens ?? 0) + incoming.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + incoming.outputTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + incoming.cacheReadTokens,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + incoming.cacheWriteTokens
  };
}

export function toSessionUsageSummary(data: ShutdownUsageEventData): SessionUsageSummary {
  const models = Object.fromEntries(
    Object.entries(data.modelMetrics).map(([model, metrics]) => [
      model,
      {
        requests: metrics.requests.count,
        inputTokens: metrics.usage.inputTokens,
        outputTokens: metrics.usage.outputTokens,
        cacheReadTokens: metrics.usage.cacheReadTokens,
        cacheWriteTokens: metrics.usage.cacheWriteTokens
      }
    ])
  );

  return {
    premiumRequests: data.totalPremiumRequests,
    models
  };
}

export function hasUsageSummary(summary: SessionUsageSummary): boolean {
  if (summary.premiumRequests > 0) {
    return true;
  }

  return Object.values(summary.models).some((model) => (
    model.requests > 0 ||
    model.inputTokens > 0 ||
    model.outputTokens > 0 ||
    model.cacheReadTokens > 0 ||
    model.cacheWriteTokens > 0
  ));
}

export async function recordDailyUsage(summary: SessionUsageSummary, at = new Date()) {
  const date = at.toISOString().slice(0, 10);
  const store = await readUsageStore();
  const snapshot = store.days[date] ?? emptyDailySnapshot(date);

  snapshot.premiumRequests += summary.premiumRequests;
  for (const [model, usage] of Object.entries(summary.models)) {
    snapshot.models[model] = mergeModelUsage(snapshot.models[model], usage);
  }
  snapshot.updatedAt = new Date().toISOString();

  store.days[date] = snapshot;
  await writeUsageStore(store);

  return snapshot;
}

export async function getDailyUsage(at = new Date()) {
  const date = at.toISOString().slice(0, 10);
  const store = await readUsageStore();
  return store.days[date] ?? emptyDailySnapshot(date);
}