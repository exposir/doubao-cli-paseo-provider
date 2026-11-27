import { createHash } from "node:crypto";
import type {
  ProviderCatalog,
  ProviderLaunch,
  ProviderMode,
  ProviderModel,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import { DEFAULT_PROBE_TIMEOUT_MS, execJson } from "./cli.js";

/**
 * `--permission-mode` is validated by the CLI itself. The three values below are the
 * complete set documented by `doubao --help`; unlike the model list they are not
 * account-specific, so they do not need a discovery round-trip.
 */
export const MODES: readonly ProviderMode[] = [
  { id: "ask_risky", label: "Ask before risky actions" },
  { id: "ask_always", label: "Always ask" },
  { id: "always_allow", label: "Allow everything", isUnattended: true },
];

const DEFAULT_MODE = "ask_risky";
const FALLBACK_THINKING: readonly ProviderThinkingOption[] = [
  { id: "high", label: "high", isDefault: true },
];

interface RawModel {
  id?: unknown;
  name?: unknown;
  is_default?: unknown;
  efforts?: unknown;
  default_effort?: unknown;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: ProviderCatalog; at: number }>();
const inflight = new Map<string, Promise<ProviderCatalog>>();

export function catalogCacheKey(launch: ProviderLaunch): string {
  const env = Object.entries(launch.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(JSON.stringify([launch.command, launch.args, env]))
    .digest("hex");
}

export function clearCatalogCache(): void {
  cache.clear();
  inflight.clear();
}

export interface CatalogOptions {
  cwd?: string;
  timeoutMs?: number;
  ttlMs?: number;
  force?: boolean;
  signal?: AbortSignal;
}

export function fallbackCatalog(): ProviderCatalog {
  return {
    models: [],
    modes: MODES,
    thinkingOptions: FALLBACK_THINKING,
    defaultMode: DEFAULT_MODE,
    defaultThinkingOption: "high",
  };
}

export async function loadCatalog(
  launch: ProviderLaunch,
  options: CatalogOptions = {},
): Promise<ProviderCatalog> {
  const key = catalogCacheKey(launch);
  const ttl = options.ttlMs ?? CACHE_TTL_MS;
  const now = Date.now();

  if (!options.force) {
    const hit = cache.get(key);
    if (hit && now - hit.at < ttl) return hit.value;

    const running = inflight.get(key);
    if (running) return running;
  }

  const pending = discoverCatalog(launch, options)
    .then((catalog) => {
      cache.set(key, { value: catalog, at: Date.now() });
      return catalog;
    })
    .catch(() => fallbackCatalog())
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, pending);
  return pending;
}

async function discoverCatalog(
  launch: ProviderLaunch,
  options: CatalogOptions,
): Promise<ProviderCatalog> {
  const payload = await execJson(
    launch,
    ["model", "list", "--output-format", "json"],
    {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      signal: options.signal,
    },
  );

  return buildCatalog(payload);
}

/** Map a `model list --output-format json` payload to a provider catalogue. */
export function buildCatalog(payload: Record<string, unknown> | null): ProviderCatalog {
  const models = parseModels(payload);
  if (models.length === 0) return fallbackCatalog();

  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const thinkingOptions = collectThinkingOptions(models);

  return {
    models,
    modes: MODES,
    thinkingOptions,
    defaultModel: defaultModel.id,
    defaultMode: DEFAULT_MODE,
    defaultThinkingOption:
      defaultModel.defaultThinkingOptionId ?? thinkingOptions[0]?.id ?? "high",
  };
}

export function parseModels(payload: Record<string, unknown> | null): ProviderModel[] {
  const result = asRecord(payload?.result);
  const rawModels = result?.models;
  if (!Array.isArray(rawModels)) return [];

  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const raw of rawModels) {
    const model = asRecord(raw) as RawModel | null;
    if (!model || typeof model.id !== "string" || model.id.length === 0) continue;
    if (seen.has(model.id)) continue;
    seen.add(model.id);

    const efforts = Array.isArray(model.efforts)
      ? model.efforts.filter((effort): effort is string => typeof effort === "string")
      : [];
    const defaultEffort =
      typeof model.default_effort === "string" ? model.default_effort : undefined;

    const thinkingOptions: ProviderThinkingOption[] = efforts.map((effort) => ({
      id: effort,
      label: effort,
      isDefault: effort === defaultEffort,
    }));

    models.push({
      id: model.id,
      label: typeof model.name === "string" && model.name ? model.name : model.id,
      isDefault: model.is_default === true,
      ...(thinkingOptions.length > 0 ? { thinkingOptions } : {}),
      ...(defaultEffort ? { defaultThinkingOptionId: defaultEffort } : {}),
    });
  }

  return models;
}

function collectThinkingOptions(models: readonly ProviderModel[]): ProviderThinkingOption[] {
  const seen = new Map<string, ProviderThinkingOption>();
  for (const model of models) {
    for (const option of model.thinkingOptions ?? []) {
      if (!seen.has(option.id)) seen.set(option.id, { id: option.id, label: option.label });
    }
  }
  return [...seen.values()];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
