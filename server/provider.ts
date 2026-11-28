import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { createDoubaoAcpProvider } from "./acp.js";
import { catalogCacheKey, fallbackCatalog, loadCatalog } from "./catalog.js";
import {
  checkDoubaoAuth,
  DOUBAO_DOCS_URL,
  doubaoProviderInstallation,
  reapStaleChildrenOnce,
  type DoubaoProviderRegistration,
} from "./cli.js";
import { DoubaoError, errorPayload } from "./errors.js";
import { resolveLimits, withTurnSlot, type Limits } from "./limits.js";
import { listSessions } from "./sessions.js";
import { Session } from "./session.js";

const CAPABILITIES = [
  "prompt.message",
  "session.configure",
  "session.persistence",
  "session.can_stop_runtime",
  "session.list",
] as const;

export type DoubaoTransport = "stream-json" | "acp";

export interface DoubaoProviderOptions {
  limits?: Partial<Limits>;
  /** Protocol backend: `stream-json` (default, per-turn process) or `acp` (`doubao acp serve`). */
  transport?: DoubaoTransport;
  /** Startup timeout when `transport` is `acp`. */
  acpStartupTimeoutMs?: number;
}

export function resolveTransport(
  explicit?: DoubaoTransport,
  env: NodeJS.ProcessEnv = process.env,
): DoubaoTransport {
  if (explicit === "acp" || explicit === "stream-json") return explicit;
  return env.DOUBAO_PASEO_TRANSPORT?.trim().toLowerCase() === "acp" ? "acp" : "stream-json";
}

export function createDoubaoProvider(options: DoubaoProviderOptions = {}): DoubaoProviderRegistration {
  if (resolveTransport(options.transport) === "acp") {
    return createDoubaoAcpProvider({ startupTimeoutMs: options.acpStartupTimeoutMs, limits: options.limits });
  }

  reapStaleChildrenOnce();
  const limits = resolveLimits(options.limits);

  return {
    id: "doubao",
    label: "Doubao CLI",
    description: "Doubao coding agent through the official doubao CLI",
    icon: "icon.svg",
    command: ["doubao"],
    docsUrl: DOUBAO_DOCS_URL,
    installation: doubaoProviderInstallation(),

    status({ launch }): Promise<ProviderStatus> {
      return checkDoubaoAuth(launch);
    },

    getCatalogCacheKey({ launch }) {
      return Promise.resolve(launch ? catalogCacheKey(launch) : undefined);
    },

    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new DoubaoError("Provider protocol version 1 is required", "UNSUPPORTED_VERSION");
      }
      if (!request.launch) {
        throw new DoubaoError("The daemon did not provide launch parameters", "NO_LAUNCH");
      }

      const capabilities = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
      return createConnection(request.launch, capabilities, limits);
    },
  };
}

function createConnection(
  launch: ProviderLaunch,
  capabilities: readonly string[],
  limits: Limits,
): ProviderConnection {
  const sessions = new Map<string, Session>();
  const listeners = new Set<(event: ProviderEvent) => void>();

  let catalog: ProviderCatalog | null = null;
  let closing = false;
  let closed = false;

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }

  function currentCatalog(): ProviderCatalog {
    return catalog ?? fallbackCatalog();
  }

  function rememberCatalog(value: ProviderCatalog): void {
    // Only pin a real model list; keep retrying if a transient probe fell back to empty.
    if (value.models.length > 0) catalog = value;
  }

  async function refreshCatalog(cwd?: string): Promise<ProviderCatalog> {
    const value = await loadCatalog(launch, { cwd });
    rememberCatalog(value);
    return value;
  }

  async function route(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog": {
        const value = await refreshCatalog(input.cwd);
        emit({ type: "catalog", requestId: input.requestId, catalog: value });
        return;
      }

      case "sessions": {
        const value = await listSessions(launch, input.cwd ?? process.cwd(), {
          limit: input.limit,
        });
        emit({ type: "sessions", requestId: input.requestId, sessions: value });
        return;
      }

      case "session.open": {
        if (sessions.has(input.sessionId)) {
          throw new DoubaoError(`Session already open: ${input.sessionId}`, "SESSION_EXISTS");
        }

        const session = new Session({
          id: input.sessionId,
          config: input.config,
          launch,
          persistence: input.persistence,
          catalog: currentCatalog,
          emit,
          limits,
        });

        sessions.set(input.sessionId, session);
        session.open(input.requestId, capabilities);

        // The catalogue is discovered in the background so opening a session never
        // waits on a network round-trip. When it lands, publish the real model list.
        void refreshCatalog(input.config.cwd)
          .then((value) => {
            if (!closed && value.models.length > 0 && sessions.get(input.sessionId) === session) {
              session.publishConfig();
            }
          })
          .catch(() => undefined);
        return;
      }

      case "session.prompt": {
        const session = requireSession(sessions, input.sessionId);
        await withTurnSlot(limits.maxConcurrentTurns, () => session.prompt(input.prompt));
        return;
      }

      case "session.configure": {
        const session = requireSession(sessions, input.sessionId);
        session.configure(input.changes);
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }

      case "session.interrupt": {
        const session = requireSession(sessions, input.sessionId);
        await session.interrupt();
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }

      case "session.can_stop_runtime": {
        const session = sessions.get(input.sessionId);
        emit({
          type: "session.can_stop_runtime",
          requestId: input.requestId,
          sessionId: input.sessionId,
          canStop: session ? session.canStopRuntime() : true,
        });
        return;
      }

      case "session.close": {
        const session = sessions.get(input.sessionId);
        if (session) {
          await session.close();
          sessions.delete(input.sessionId);
        }
        emit({ type: "session.closed", sessionId: input.sessionId });
        return;
      }

      default: {
        const type = (input as { type: string }).type;
        throw new DoubaoError(`Unsupported request: ${type}`, "UNSUPPORTED_REQUEST");
      }
    }
  }

  function failed(input: ProviderInput, error: unknown): void {
    const payload = errorPayload(error);

    if (input.type === "session.prompt") {
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: payload },
      });
      return;
    }

    if ("requestId" in input) {
      emit({ type: "request.failed", requestId: input.requestId, error: payload });
    }
  }

  return {
    version: 1,
    capabilities,

    async send(input) {
      if (closing || closed) throw new DoubaoError("Connection is closed", "CLOSED");
      requireProviderCapabilities(capabilities, input);
      // Requests are independent on purpose: a long turn in one session must not
      // queue catalogue reads, configuration changes or other sessions behind it.
      void route(input).catch((error) => failed(input, error));
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async close() {
      if (closing || closed) return;
      closing = true;
      // Keep emitting until active sessions report their terminal canceled events.
      await Promise.all([...sessions.values()].map((session) => session.close()));
      closed = true;
      sessions.clear();
      listeners.clear();
    },
  };
}

function requireSession(sessions: Map<string, Session>, id: string): Session {
  const session = sessions.get(id);
  if (!session) throw new DoubaoError(`Unknown session: ${id}`, "UNKNOWN_SESSION");
  return session;
}
