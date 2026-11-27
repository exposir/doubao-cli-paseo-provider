import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { createDoubaoProvider } from "../server/provider.js";

const LIVE = process.env.DOUBAO_LIVE === "1";

/**
 * End-to-end check of the provider connection against the real CLI.
 * Run with `npm run test:live`; it sends one tiny prompt.
 */
test(
  "live: a turn streams text and stores the native session id",
  { skip: !LIVE, timeout: 180_000 },
  async () => {
    const registration = createDoubaoProvider();
    const connection = await registration.connect({
      versions: [1],
      capabilities: [
        "prompt.message",
        "session.configure",
        "session.persistence",
        "session.can_stop_runtime",
        "session.list",
      ],
      launch: { command: "doubao", args: [], env: env() },
    });

    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));

    const sessionId = `test-${Date.now()}`;
    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId,
      history: "skip",
      config: {
        cwd: "/tmp",
        env: {},
        mcpServers: {},
        settings: {},
        persist: true,
      },
    });

    await connection.send({
      type: "session.prompt",
      sessionId,
      prompt: {
        clientMessageId: "msg-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "只回复两个字：OK" }] },
      },
    });

    await waitFor(
      () =>
        events.some(
          (event) => event.type === "session.turn" && event.state === "completed",
        ),
      150_000,
    );

    const text = events
      .filter(
        (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
      )
      .map((event) => (event.type === "timeline.item" && event.item.type === "assistant_message" ? event.item.text : ""))
      .join("");

    assert.match(text, /OK/);
    assert.ok(
      events.some((event) => event.type === "session.persistence"),
      "expected the native doubao session id to be persisted",
    );

    await connection.close();
  },
);

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the turn to finish");
}

function env(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
