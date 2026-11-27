import type {
  ProviderLaunch,
  ProviderSessionSummary,
} from "@getpaseo/plugin/server/provider";
import { execJson } from "./cli.js";

interface RawSession {
  session_id?: unknown;
  title?: unknown;
  updated_at?: unknown;
  cwd?: unknown;
}

/**
 * `doubao --list --output-format json` returns:
 * { result: { type: "session_list", sessions: [{ session_id, title, updated_at }] } }
 */
export async function listSessions(
  launch: ProviderLaunch,
  cwd: string,
  options: { limit?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProviderSessionSummary[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const payload = await execJson(
    launch,
    ["--list", "--output-format", "json", "--limit", String(limit)],
    { timeoutMs: options.timeoutMs, signal: options.signal },
  );

  return parseSessionList(payload, cwd);
}

export function parseSessionList(
  payload: Record<string, unknown> | null,
  fallbackCwd: string,
): ProviderSessionSummary[] {
  const result = asRecord(payload?.result);
  const rawSessions = result?.sessions;
  if (!Array.isArray(rawSessions)) return [];

  const sessions: ProviderSessionSummary[] = [];
  for (const raw of rawSessions) {
    const record = asRecord(raw) as RawSession | null;
    if (!record || typeof record.session_id !== "string" || !record.session_id) continue;

    sessions.push({
      persistence: {
        version: 1,
        data: { doubaoSessionId: record.session_id },
      },
      cwd: typeof record.cwd === "string" ? record.cwd : fallbackCwd,
      title: typeof record.title === "string" ? record.title : undefined,
      updatedAt: typeof record.updated_at === "string" ? record.updated_at : undefined,
    });
  }

  return sessions;
}

export function readPersistedSessionId(
  persistence: { data: unknown } | undefined,
): string | null {
  const data = asRecord(persistence?.data);
  return data && typeof data.doubaoSessionId === "string" ? data.doubaoSessionId : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
