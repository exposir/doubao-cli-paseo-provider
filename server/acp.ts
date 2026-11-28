import {
  isProviderCapability,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderSessionSummary,
} from "@getpaseo/plugin/server/provider";
import { ACP_MODES, field, records } from "./acp-protocol.js";
import { AcpRuntime } from "./acp-runtime.js";
import { AcpSession, acpPersistence } from "./acp-session.js";
import { catalogCacheKey, fallbackCatalog, loadCatalog } from "./catalog.js";
import {
  baseCliArgs,
  checkDoubaoAuth,
  DOUBAO_DOCS_URL,
  doubaoProviderInstallation,
  hasAcpFlag,
  probeEnv,
  reapStaleChildrenOnce,
  type DoubaoProviderRegistration,
} from "./cli.js";
import { DoubaoError, errorPayload } from "./errors.js";
import { resolveLimits, withTurnSlot, type Limits } from "./limits.js";

const STARTUP_TIMEOUT_MS = 20_000;
const SESSION_SCAN_LIMIT = 500;
const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "session.configure",
  "session.persistence",
  "session.can_stop_runtime",
  "session.launch_wrap",
  "session.list",
  "permission",
  "request.cancel",
] as const;

export interface DoubaoAcpProviderOptions {
  startupTimeoutMs?: number;
  command?: readonly [string, ...string[]];
  limits?: Partial<Limits>;
}

type ListInput = Extract<ProviderInput, { type: "sessions" }>;
// Request cancellation was introduced after the 0.15 SDK.
type AcpInput = ProviderInput | { type: "request.cancel"; requestId: string };

export function createDoubaoAcpProvider(
  options: DoubaoAcpProviderOptions = {},
): DoubaoProviderRegistration {
  reapStaleChildrenOnce();
  const limits = resolveLimits(options.limits);
  const command = options.command ?? ["doubao", "acp", "serve"] as const;
  const timeout = options.startupTimeoutMs && options.startupTimeoutMs > 0
    ? options.startupTimeoutMs : STARTUP_TIMEOUT_MS;
  return {
    id: "doubao",
    label: "Doubao CLI",
    description: "Doubao coding agent through the official doubao CLI (ACP)",
    icon: "icon.svg",
    command,
    docsUrl: DOUBAO_DOCS_URL,
    installation: doubaoProviderInstallation(),
    ...(isProviderCapability("session.launch_wrap") ? { launchWrap: true } : {}),

    status({ launch }) {
      return checkDoubaoAuth(launch);
    },

    async getCatalogCacheKey({ launch }) {
      return launch ? catalogCacheKey(modelLaunch(launch)) : undefined;
    },

    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new DoubaoError("Provider protocol version 1 is required", "UNSUPPORTED_VERSION");
      }
      const launch = request.launch ?? {
        command: command[0], args: command.slice(1), env: probeEnv(process.env),
      };
      const args = hasAcpFlag(launch.args) ? launch.args : [...launch.args, "acp", "serve"];
      const capabilities = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
      return createConnection({ ...launch, args }, capabilities, limits, timeout);
    },
  };
}

function modelLaunch(launch: ProviderLaunch): ProviderLaunch {
  return { ...launch, args: baseCliArgs(launch.args) };
}

function acpCatalog(catalog: ProviderCatalog): ProviderCatalog {
  return { ...catalog, modes: ACP_MODES, defaultMode: "default" };
}

function createConnection(
  launch: ProviderLaunch,
  capabilities: readonly string[],
  limits: Limits,
  startupTimeoutMs: number,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, AcpSession>();
  const cancellable = new Map<string, AbortController>();
  const probes = new Set<Promise<void>>();
  let catalog = acpCatalog(fallbackCatalog());
  let closing: Promise<void> | undefined;

  function emit(event: ProviderEvent): void {
    for (const listener of listeners) listener(event);
  }

  function requireSession(id: string): AcpSession {
    const session = sessions.get(id);
    if (!session) throw new DoubaoError(`Unknown session: ${id}`, "UNKNOWN_SESSION");
    return session;
  }

  async function dispatch(input: Exclude<AcpInput, { type: "request.cancel" }>, signal?: AbortSignal) {
    switch (input.type) {
      case "catalog": {
        const discovered = acpCatalog(await loadCatalog(modelLaunch(launch), {
          cwd: input.cwd,
          signal,
        }));
        if (discovered.models.length > 0) catalog = discovered;
        if (!signal?.aborted) emit({ type: "catalog", requestId: input.requestId, catalog: discovered });
        return;
      }
      case "sessions": {
        const value = await listAcpSessions(launch, input, limits, startupTimeoutMs, signal);
        if (!signal?.aborted) emit({ type: "sessions", requestId: input.requestId, sessions: value });
        return;
      }
      case "session.open": {
        const id = input.sessionId;
        if (sessions.has(id)) throw new DoubaoError(`Session already open: ${id}`, "SESSION_EXISTS");
        const session = new AcpSession({
          id,
          config: input.config,
          persistence: input.persistence,
          launch,
          catalog: () => catalog,
          emit,
          limits,
          startupTimeoutMs,
          capabilities,
        });
        sessions.set(id, session);
        try {
          await session.open(input.requestId, input.history);
        } catch (error) {
          await session.close();
          if (sessions.get(id) === session) sessions.delete(id);
          throw error;
        }
        return;
      }
      case "session.prompt":
        await withTurnSlot(limits.maxConcurrentTurns, () => requireSession(input.sessionId).prompt(input.prompt));
        return;
      case "session.configure":
        await requireSession(input.sessionId).configure(input.changes);
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      case "session.interrupt":
        await requireSession(input.sessionId).interrupt();
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      case "session.permission":
        requireSession(input.sessionId).respondToPermission(input.permissionId, input.response);
        return;
      case "session.can_stop_runtime":
        emit({
          type: "session.can_stop_runtime", requestId: input.requestId, sessionId: input.sessionId,
          canStop: sessions.get(input.sessionId)?.canStopRuntime() ?? true,
        });
        return;
      case "session.close": {
        const session = sessions.get(input.sessionId);
        await session?.close();
        if (sessions.get(input.sessionId) === session) sessions.delete(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        return;
      }
      default:
        throw new DoubaoError(`Unsupported request: ${input.type}`, "UNSUPPORTED_REQUEST");
    }
  }

  function fail(input: AcpInput, error: unknown): void {
    const payload = errorPayload(error);
    if (input.type === "session.prompt") {
      emit({
        type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: payload },
      });
    } else if ("requestId" in input) {
      emit({ type: "request.failed", requestId: input.requestId, error: payload });
    } else if ("sessionId" in input) {
      emit({ type: "session.runtime_failed", sessionId: input.sessionId, error: payload });
    }
  }

  return {
    version: 1,
    capabilities,
    async send(input: AcpInput) {
      if (closing) throw new DoubaoError("Connection is closed", "CLOSED");
      if (input.type === "request.cancel") {
        if (!capabilities.includes("request.cancel")) throw new DoubaoError("Provider does not support request.cancel", "UNSUPPORTED_REQUEST");
        cancellable.get(input.requestId)?.abort();
        return;
      }
      requireProviderCapabilities(capabilities, input);
      if (input.type === "catalog" || input.type === "sessions") {
        const requestId = input.requestId;
        const controller = new AbortController();
        cancellable.set(requestId, controller);
        const task = dispatch(input, controller.signal).catch((error) => {
          if (!controller.signal.aborted) fail(input, error);
        }).finally(() => {
          if (cancellable.get(requestId) === controller) cancellable.delete(requestId);
          probes.delete(task);
        });
        if (input.type === "sessions") probes.add(task);
        return;
      }
      void dispatch(input).catch((error) => fail(input, error));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closing ??= Promise.resolve().then(async () => {
        for (const controller of cancellable.values()) controller.abort();
        await Promise.all([
          ...probes,
          ...[...sessions.values()].map((session) => session.close()),
        ]);
        sessions.clear();
        listeners.clear();
      });
      return closing;
    },
  };
}

async function listAcpSessions(
  launch: ProviderLaunch,
  input: ListInput,
  limits: Limits,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProviderSessionSummary[]> {
  signal?.throwIfAborted();
  const runtime = new AcpRuntime({ launch, cwd: input.cwd, maxStderrBytes: limits.maxStderrBytes });
  try {
    await runtime.initialize(timeoutMs, signal);
    const expires = AbortSignal.timeout(timeoutMs);
    const scanSignal = signal ? AbortSignal.any([signal, expires]) : expires;
    const limit = Math.min(200, Math.max(1, input.limit ?? 50));
    const query = input.query?.trim().toLowerCase();
    const sessions: ProviderSessionSummary[] = [];
    const seenSessions = new Set<string>();
    const seenCursors = new Set<string>();
    let scanned = 0;
    let cursor: string | undefined;
    do {
      let page;
      try {
        page = await runtime.rpc.request("session/list", { cwd: input.cwd, cursor }, { signal: scanSignal });
      } catch (error) {
        if (expires.aborted && !signal?.aborted) {
          throw new DoubaoError(`Doubao ACP session/list timed out after ${timeoutMs} ms`, "ACP_REQUEST_TIMEOUT");
        }
        throw error;
      }
      for (const entry of records(page.sessions)) {
        if (++scanned > SESSION_SCAN_LIMIT) break;
        const id = field(entry, "sessionId");
        const cwd = field(entry, "cwd") || input.cwd || process.cwd();
        const title = field(entry, "title");
        if (!id || seenSessions.has(id) || (query && !`${title ?? ""} ${cwd}`.toLowerCase().includes(query))) continue;
        seenSessions.add(id);
        sessions.push({ persistence: acpPersistence(id), cwd, title, updatedAt: field(entry, "updatedAt") });
        if (sessions.length >= limit) break;
      }
      cursor = field(page, "nextCursor");
      if (!cursor || seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    } while (sessions.length < limit && scanned < SESSION_SCAN_LIMIT && seenCursors.size < SESSION_SCAN_LIMIT);
    return sessions;
  } catch (error) {
    throw runtime.withDiagnostic(error);
  } finally {
    await runtime.close();
  }
}
