import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionList, readPersistedSessionId } from "../server/sessions.js";

test("parseSessionList maps the JSON protocol payload", () => {
  const sessions = parseSessionList(
    {
      type: "result",
      subtype: "success",
      result: {
        type: "session_list",
        count: 2,
        sessions: [
          { session_id: "38456440663565058", title: "每日吃啥", updated_at: "2026-11-27T12:52:53+08:00" },
          { session_id: "38453554607313922", title: "电脑", updated_at: "2026-11-27T01:45:05+08:00" },
        ],
      },
    },
    "/root/work",
  );

  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0].persistence, {
    version: 1,
    data: { doubaoSessionId: "38456440663565058" },
  });
  assert.equal(sessions[0].title, "每日吃啥");
  assert.equal(sessions[0].cwd, "/root/work");
  assert.equal(sessions[1].updatedAt, "2026-11-27T01:45:05+08:00");
});

test("parseSessionList skips entries without an id", () => {
  const sessions = parseSessionList(
    { result: { sessions: [{ title: "no id" }, { session_id: "ok" }, null] } },
    "/tmp",
  );
  assert.deepEqual(
    sessions.map((session) => session.persistence.data),
    [{ doubaoSessionId: "ok" }],
  );
});

test("parseSessionList returns an empty list for a malformed payload", () => {
  assert.deepEqual(parseSessionList(null, "/tmp"), []);
  assert.deepEqual(parseSessionList({ result: {} }, "/tmp"), []);
});

test("readPersistedSessionId reads the stored native id", () => {
  assert.equal(readPersistedSessionId({ data: { doubaoSessionId: "123" } }), "123");
  assert.equal(readPersistedSessionId({ data: {} }), null);
  assert.equal(readPersistedSessionId(undefined), null);
  assert.equal(readPersistedSessionId({ data: { doubaoSessionId: 7 } }), null);
});

test("a non-array sessions field yields an empty list", () => {
  assert.deepEqual(parseSessionList({ result: { sessions: "nope" } }, "/tmp"), []);
  assert.deepEqual(parseSessionList({ result: { sessions: {} } }, "/tmp"), []);
});

test("an empty session id is skipped", () => {
  const sessions = parseSessionList(
    { result: { sessions: [{ session_id: "" }, { session_id: "ok" }] } },
    "/tmp",
  );
  assert.equal(sessions.length, 1);
});

test("wrongly typed metadata is dropped instead of copied", () => {
  const sessions = parseSessionList(
    {
      result: {
        sessions: [
          { session_id: "s1", title: 42, updated_at: false, cwd: 7 },
        ],
      },
    },
    "/fallback",
  );

  assert.equal(sessions[0].title, undefined);
  assert.equal(sessions[0].updatedAt, undefined);
  assert.equal(sessions[0].cwd, "/fallback");
});

test("a session cwd from the CLI wins over the fallback", () => {
  const sessions = parseSessionList(
    { result: { sessions: [{ session_id: "s1", cwd: "/from/cli" }] } },
    "/fallback",
  );
  assert.equal(sessions[0].cwd, "/from/cli");
});

test("readPersistedSessionId tolerates non-object data", () => {
  assert.equal(readPersistedSessionId({ data: null }), null);
  assert.equal(readPersistedSessionId({ data: ["doubaoSessionId"] }), null);
  assert.equal(readPersistedSessionId({ data: "123" }), null);
});
