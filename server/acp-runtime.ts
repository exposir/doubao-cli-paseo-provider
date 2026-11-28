import type { ChildProcess } from "node:child_process";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { AcpJsonRpcClient } from "./acp-protocol.js";
import { killChildTree, signalProcessGroup, spawnAcpProcess } from "./cli.js";
import { DoubaoError } from "./errors.js";
import { BoundedText } from "./limits.js";

const EXIT_GRACE_MS = 500;

export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface RuntimeOptions {
  launch: ProviderLaunch;
  cwd?: string;
  wrap?: readonly [string, ...string[]];
  maxStderrBytes: number;
  handlers?: ConstructorParameters<typeof AcpJsonRpcClient>[2];
  onFailure?(error: DoubaoError): void;
  onActivity?(): void;
}

/** Owns the child and the pipe lifetime, including one-shot session/list probes. */
export class AcpRuntime {
  readonly rpc: AcpJsonRpcClient;
  private readonly child: ChildProcess;
  private readonly stderr: BoundedText;
  private readonly exited: Promise<void>;
  private closing?: Promise<void>;
  private didExit = false;

  constructor(options: RuntimeOptions) {
    const child = spawnAcpProcess(options.launch, options.cwd, options.wrap);
    this.child = child;
    this.stderr = new BoundedText(options.maxStderrBytes);
    this.rpc = new AcpJsonRpcClient(child.stdout!, child.stdin!, {
      ...options.handlers,
      protocolError: (error) => {
        options.onFailure?.(this.withDiagnostic(error));
        void this.close(true);
      },
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      options.onActivity?.();
      this.stderr.append(chunk);
    });
    child.stderr?.on("error", () => {});

    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.once("exit", () => {
      // If the launcher exits first, a helper can survive and hold the pipes open.
      signalProcessGroup(child, "SIGKILL");
    });
    this.exited = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        this.didExit = true;
        const failure = this.withDiagnostic(new DoubaoError(
          spawnError?.message ?? `Doubao ACP process exited (${signal ?? code ?? "unknown status"})`,
          spawnError ? "SPAWN_ERROR" : code === 4 ? "DOUBAO_LOGIN_REQUIRED" : "ACP_RUNTIME_EXIT",
        ));
        this.rpc.fail(failure);
        if (!this.closing) options.onFailure?.(failure);
        resolve();
      });
    });
  }

  async initialize(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const info = await this.rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true },
        elicitation: { form: {} },
      },
      clientInfo: { name: "paseo", version: "1" },
    }, { timeoutMs, signal });
    if (info.protocolVersion !== 1) {
      throw new DoubaoError(
        `Doubao ACP returned an unsupported protocol version (${info.protocolVersion ?? "missing"})`,
        "ACP_PROTOCOL_ERROR",
      );
    }
  }

  withDiagnostic(error: unknown): DoubaoError {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof DoubaoError ? error.code : "DOUBAO_ACP_ERROR";
    const stderr = this.stderr.toString().trim();
    return error instanceof DoubaoError && (!stderr || message.endsWith(stderr))
      ? error
      : new DoubaoError(stderr ? `${message}\nDoubao stderr:\n${stderr}` : message, code);
  }

  close(force = false): Promise<void> {
    this.closing ??= this.stop(force);
    return this.closing;
  }

  private async stop(force: boolean): Promise<void> {
    if (this.didExit) return;
    if (!force) {
      this.child.stdin?.end();
      if (await settlesWithin(this.exited, EXIT_GRACE_MS)) return;
      await killChildTree(this.child, "SIGINT");
      if (await settlesWithin(this.exited, EXIT_GRACE_MS)) return;
    }
    await killChildTree(this.child, "SIGKILL");
    if (!await settlesWithin(this.exited, EXIT_GRACE_MS)) {
      this.rpc.fail(this.withDiagnostic(new DoubaoError("Doubao ACP process was stopped", "ACP_RUNTIME_EXIT")));
    }
  }
}
