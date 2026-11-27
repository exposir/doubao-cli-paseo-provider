import { execCommand } from "@getpaseo/plugin/server";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderRegistration,
  type ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { catalogCacheKey, fallbackCatalog, loadCatalog } from "./catalog.js";
import { DoubaoError, errorPayload } from "./errors.js";
import { resolveLimits, type Limits } from "./limits.js";
import { listSessions } from "./sessions.js";
import { Session } from "./session.js";

const CAPABILITIES = [
  "prompt.message",
  "session.configure",
  "session.persistence",
  "session.can_stop_runtime",
  "session.list",
] as const;

const AUTH_TIMEOUT_MS = 5000;

export interface DoubaoProviderOptions {
  limits?: Partial<Limits>;
}

export function createDoubaoProvider(options: DoubaoProviderOptions = {}): ProviderRegistration {
  const limits = resolveLimits(options.limits);

  return {
    id: "doubao",
    label: "Doubao CLI",
    description: "Doubao coding agent through the official doubao CLI",
    icon: "icon.svg",
    command: ["doubao"],

    async status({ launch }): Promise<ProviderStatus> {
      if (!launch) {
        return {
          available: false,
          diagnostic: "doubao was not found on PATH. Install the Doubao CLI and make sure it is reachable.",
        };
      }

      try {
        await execCommand(launch.command, [...launch.args, "auth", "status"], {
          env: launch.env,
          timeout: AUTH_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        });
        return { available: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          available: false,
          diagnostic: `doubao is installed but not usable (${message}). Run \`doubao login\` in a terminal.`,
        };
      }
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
  let catalogLoading: Promise<ProviderCatalog> | null = null;
  let activeTurns = 0;
  let closed = false;

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }

  function currentCatalog(): ProviderCatalog {
    return catalog ?? fallbackCatalog();
  }

  function ensureCatalog(cwd?: string): Promise<ProviderCatalog> {
    if (catalog) return Promise.resolve(catalog);
    if (!catalogLoading) {
      catalogLoading = loadCatalog(launch, { cwd })
        .then((value) => {
          catalog = value;
          return value;
        })
        .finally(() => {
          catalogLoading = null;
        });
    }
    return catalogLoading;
  }

  async function route(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog": {
        const value = await loadCatalog(launch, { cwd: input.cwd });
        catalog = value;
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
        void ensureCatalog(input.config.cwd)
          .then(() => {
            if (!closed && sessions.get(input.sessionId) === session) session.publishConfig();
          })
          .catch(() => undefined);
        return;
      }

      case "session.prompt": {
        const session = requireSession(sessions, input.sessionId);
        if (limits.maxConcurrentTurns > 0 && activeTurns >= limits.maxConcurrentTurns) {
          throw new DoubaoError(
            `Too many concurrent Doubao turns (limit ${limits.maxConcurrentTurns}); wait for one to finish or raise the limit`,
            "TOO_MANY_TURNS",
          );
        }
        activeTurns += 1;
        try {
          await session.prompt(input.prompt);
        } finally {
          activeTurns -= 1;
        }
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
      if (closed) throw new DoubaoError("Connection is closed", "CLOSED");
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
      if (closed) return;
      closed = true;
      await Promise.all([...sessions.values()].map((session) => session.close()));
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
