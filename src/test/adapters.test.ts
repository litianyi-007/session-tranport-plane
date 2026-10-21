import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { agyAdapter, parseAgyTranscript } from "../adapters/agy.js";
import { claudeAdapter, parseClaudeJsonl } from "../adapters/claude.js";
import { codexAdapter, parseCodexRollout } from "../adapters/codex.js";
import { cursorAdapter, parseCursorJsonl } from "../adapters/cursor.js";
import { deepseekAdapter, parseDshLog, readSessionText } from "../adapters/deepseek.js";
import { parseGrokUpdates } from "../adapters/grok.js";
import { grokAdapter } from "../adapters/grok.js";
import { parsePiJsonl, piAdapter } from "../adapters/pi.js";
import { applyFidelity } from "../csir.js";

const claudeLog = [
  JSON.stringify({
    type: "user",
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "sess-claude",
    cwd: "/work/app",
    message: { role: "user", content: "Fix the login bug" },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-01-01T00:00:01.000Z",
    cwd: "/work/app",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I'll inspect auth." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls src" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "ls: src: No such file" }],
    },
  }),
  JSON.stringify({
    type: "system",
    timestamp: "2026-01-01T00:00:03.000Z",
    isCompactSummary: true,
    message: { role: "system", content: "Summary: login bug still open." },
  }),
  JSON.stringify({
    type: "user",
    timestamp: "2026-01-01T00:00:04.000Z",
    cwd: "/work/app",
    message: { role: "user", content: "Continue after compact" },
  }),
].join("\n");

test("claude parser keeps dialog, a failed tool, and the compact summary", () => {
  const csir = parseClaudeJsonl(claudeLog, { nativeId: "sess-claude", path: "/tmp/sess.jsonl" });
  assert.equal(csir.session.cwd, "/work/app");
  assert.equal(csir.session.title, "Fix the login bug");
  const roles = csir.events.map((event) => event.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "compact", "user"]);
  assert.equal(csir.events[2]?.tool?.name, "Bash");
  assert.equal(csir.events[2]?.tool?.ok, false);
  assert.match(csir.events[2]?.tool?.output_excerpt ?? "", /No such file/);
  const l2 = applyFidelity(csir.events, "L2");
  assert.equal(l2.filter((event) => event.role === "tool").length, 1);
});

test("codex parser prefers event_msg text and command failures", () => {
  const text = [
    JSON.stringify({
      timestamp: "2026-01-02T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "codex-1", cwd: "/work/app", timestamp: "2026-01-02T00:00:00.000Z", forked_from_id: "parent-1" },
    }),
    JSON.stringify({
      timestamp: "2026-01-02T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Add a test" },
    }),
    JSON.stringify({
      timestamp: "2026-01-02T00:00:02.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "I will add it.", phase: "final_answer" },
    }),
    JSON.stringify({
      timestamp: "2026-01-02T00:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          command: "npm test",
          aggregated_output: "fail",
          exit_code: 1,
          status: "failed",
        },
      },
    }),
    JSON.stringify({
      timestamp: "2026-01-02T00:00:04.000Z",
      type: "event_msg",
      payload: { type: "context_compacted", message: "Compacted: test still failing" },
    }),
    JSON.stringify({
      timestamp: "2026-01-02T00:00:05.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "After compact, fix it" },
    }),
  ].join("\n");
  const csir = parseCodexRollout(text, { nativeId: "fallback" });
  assert.equal(csir.session.native_id, "codex-1");
  assert.equal(csir.session.lineage.mode, "fork");
  assert.equal(csir.events[0]?.text, "Add a test");
  assert.equal(csir.events[2]?.tool?.ok, false);
  assert.equal(csir.events[3]?.role, "compact");
  assert.equal(csir.events.at(-1)?.text, "After compact, fix it");
});

test("cursor parser unwraps user_query and marks tools failed when the turn errors", () => {
  const text = [
    JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "<user_query>\nRename the CLI\n</user_query>" }] },
    }),
    JSON.stringify({
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", name: "Shell", input: { command: "ls" } },
        ],
      },
    }),
    JSON.stringify({ type: "turn_ended", status: "error" }),
    JSON.stringify({
      role: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { path: "README.md" } }],
      },
    }),
    JSON.stringify({ type: "turn_ended", status: "success" }),
  ].join("\n");
  const csir = parseCursorJsonl(text, { nativeId: "cur-1", cwd: "/work/app" });
  assert.equal(csir.events[0]?.text, "Rename the CLI");
  assert.equal(csir.events.find((event) => event.tool?.name === "Shell")?.tool?.ok, false);
  assert.equal(csir.events.find((event) => event.tool?.name === "Read")?.tool?.ok, undefined);
  const failed = applyFidelity(csir.events, "L2").filter((event) => event.role === "tool");
  assert.deepEqual(failed.map((event) => event.tool?.name), ["Shell"]);
});

test("pi parser follows the active branch and records tool errors", () => {
  const text = [
    JSON.stringify({ type: "session", version: 3, id: "pi-1", timestamp: "2026-01-03T00:00:00.000Z", cwd: "/work/app" }),
    JSON.stringify({ type: "session_info", id: "n1", parentId: null, timestamp: "2026-01-03T00:00:00.000Z", name: "Pi rename" }),
    JSON.stringify({
      type: "message",
      id: "m1",
      parentId: "n1",
      timestamp: "2026-01-03T00:00:01.000Z",
      message: { role: "user", content: "Hello pi", timestamp: 1 },
    }),
    JSON.stringify({
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: "2026-01-03T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hi" },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "false" } },
        ],
        timestamp: 2,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "m3",
      parentId: "m2",
      timestamp: "2026-01-03T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "exit 1" }],
        isError: true,
        timestamp: 3,
      },
    }),
    JSON.stringify({
      type: "compaction",
      id: "c",
      parentId: "m3",
      timestamp: "2026-01-03T00:00:04.000Z",
      summary: "Said hello",
      firstKeptEntryId: "m3",
    }),
    JSON.stringify({
      type: "message",
      id: "m4",
      parentId: "c",
      timestamp: "2026-01-03T00:00:05.000Z",
      message: { role: "user", content: "After", timestamp: 4 },
    }),
  ].join("\n");
  const csir = parsePiJsonl(text, { nativeId: "fallback", path: "/tmp/pi.jsonl" });
  assert.equal(csir.session.native_id, "pi-1");
  assert.equal(csir.session.title, "Pi rename");
  assert.equal(csir.events.find((event) => event.role === "tool")?.tool?.ok, false);
  assert.equal(csir.events.find((event) => event.role === "compact")?.text, "Said hello");
  assert.equal(csir.events.at(-1)?.text, "After");
});

test("agy parser unwraps USER_REQUEST and skips housekeeping", () => {
  const text = [
    JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-01-04T00:00:00.000Z",
      content: "<USER_REQUEST>\nShip the parser\n</USER_REQUEST>",
    }),
    JSON.stringify({
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "ERROR",
      created_at: "2026-01-04T00:00:01.000Z",
      content: "I will read the file.",
      tool_calls: [{ id: "t", name: "read_file", args: { path: "missing.ts" } }],
    }),
    JSON.stringify({
      step_index: 2,
      source: "SYSTEM",
      type: "CONVERSATION_HISTORY",
      status: "DONE",
      created_at: "2026-01-04T00:00:02.000Z",
      content: "noise",
    }),
  ].join("\n");
  const csir = parseAgyTranscript(text, { nativeId: "agy-1" });
  assert.equal(csir.events[0]?.text, "Ship the parser");
  assert.equal(csir.events.find((event) => event.tool?.name === "read_file")?.tool?.ok, false);
  assert.equal(csir.events.some((event) => event.text === "noise"), false);
  assert.ok(csir.events[1]?.files_touched?.includes("missing.ts") || csir.events.some((event) => event.files_touched?.includes("missing.ts")));
});

test("grok parser joins chunks and keeps a failed tool update", () => {
  const text = [
    JSON.stringify({
      timestamp: 1767225600000,
      method: "session/update",
      params: {
        sessionId: "grok-1",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Read README" } },
      },
    }),
    JSON.stringify({
      timestamp: 1767225601000,
      method: "session/update",
      params: {
        sessionId: "grok-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On it." } },
      },
    }),
    JSON.stringify({
      timestamp: 1767225602000,
      method: "session/update",
      params: {
        sessionId: "grok-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "Read README",
          status: "in_progress",
          rawInput: { path: "README.md" },
          _meta: { "x.ai/tool": { name: "read_file" } },
        },
      },
    }),
    JSON.stringify({
      timestamp: 1767225603000,
      method: "session/update",
      params: {
        sessionId: "grok-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "failed",
          content: [{ type: "content", content: { type: "text", text: "missing" } }],
        },
      },
    }),
  ].join("\n");
  const csir = parseGrokUpdates(text, { nativeId: "grok-1", cwd: "/work/app", title: "Grok task" });
  assert.equal(csir.session.title, "Grok task");
  assert.equal(csir.events[0]?.text, "Read README");
  assert.equal(csir.events[1]?.text, "On it.");
  assert.equal(csir.events[2]?.tool?.name, "read_file");
  assert.equal(csir.events[2]?.tool?.ok, false);
  assert.match(csir.events[2]?.tool?.output_excerpt ?? "", /missing/);
});

test("deepseek parser reads a zstd log and skips reasoning", () => {
  const raw = [
    JSON.stringify({ type: "session", version: 3, id: "dsh-1", createdAt: 1760000000000, cwd: "/work/app" }),
    JSON.stringify({ type: "session/title", seq: 1, time: 1760000001000, data: { title: "Dsh task" } }),
    JSON.stringify({
      type: "user/message",
      seq: 2,
      time: 1760000002000,
      data: { content: [{ type: "text", text: "Explain event sourcing" }] },
    }),
    JSON.stringify({
      type: "assistant/message",
      seq: 3,
      time: 1760000003000,
      data: {
        content: [
          { type: "reasoning", text: "hidden reasoning" },
          { type: "text", text: "It is an append-only log." },
        ],
      },
    }),
    JSON.stringify({
      type: "tool/call",
      seq: 4,
      time: 1760000004000,
      data: { callId: "c1", name: "read", arguments: JSON.stringify({ path: "a.ts" }) },
    }),
    JSON.stringify({
      type: "tool/result",
      seq: 5,
      time: 1760000005000,
      data: {
        message: { content: [{ type: "text", text: "ENOENT" }], isError: true },
        error: { name: "Error", code: "ENOENT", reason: "missing" },
      },
    }),
    JSON.stringify({
      type: "compaction/summary",
      seq: 6,
      time: 1760000006000,
      data: { summary: [{ type: "text", text: "User asked about event sourcing." }] },
    }),
    JSON.stringify({
      type: "user/message",
      seq: 7,
      time: 1760000007000,
      data: { content: "Continue" },
    }),
  ].join("\n");
  const dir = mkdtempSync(join(tmpdir(), "stp-dsh-"));
  const file = join(dir, "session.v3.jsonl.zstd");
  writeFileSync(file, zstdCompressSync(Buffer.from(raw)));
  const csir = parseDshLog(readSessionText(file), { nativeId: "fallback" });
  assert.equal(csir.session.native_id, "dsh-1");
  assert.equal(csir.session.title, "Dsh task");
  assert.equal(csir.events.some((event) => event.text?.includes("hidden reasoning")), false);
  assert.equal(csir.events.find((event) => event.tool?.name === "read")?.tool?.ok, false);
  assert.equal(csir.events.find((event) => event.role === "compact")?.text, "User asked about event sourcing.");
  assert.equal(csir.events.at(-1)?.text, "Continue");
});

test("discover finds sessions scoped to cwd for the core adapters", () => {
  const home = mkdtempSync(join(tmpdir(), "stp-home-"));
  const cwd = "/work/app";
  const env = { HOME: home, PATH: process.env.PATH ?? "" };

  mkdirSync(join(home, ".claude", "projects", "-work-app"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", "-work-app", "sess-claude.jsonl"), claudeLog);

  mkdirSync(join(home, ".codex", "sessions", "2026", "01", "02"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "sessions", "2026", "01", "02", "rollout-2026-01-02T00-00-00-codex-1.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-01-02T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-1", cwd, timestamp: "2026-01-02T00:00:00.000Z" },
      }),
      JSON.stringify({
        timestamp: "2026-01-02T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Add a test" },
      }),
    ].join("\n"),
  );

  mkdirSync(join(home, ".cursor", "projects", "-work-app", "agent-transcripts", "cur-1"), { recursive: true });
  writeFileSync(
    join(home, ".cursor", "projects", "-work-app", "agent-transcripts", "cur-1", "cur-1.jsonl"),
    JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>\nRename\n</user_query>" }] } }),
  );

  mkdirSync(join(home, ".pi", "agent", "sessions", "--work-app--"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "sessions", "--work-app--", "2026-01-03T00-00-00_pi-1.jsonl"),
    JSON.stringify({ type: "session", version: 3, id: "pi-1", timestamp: "2026-01-03T00:00:00.000Z", cwd }),
  );

  const agyId = "agy-1";
  mkdirSync(join(home, ".gemini", "antigravity-cli", "conversations"), { recursive: true });
  mkdirSync(join(home, ".gemini", "antigravity-cli", "brain", agyId, ".system_generated", "logs"), { recursive: true });
  mkdirSync(join(home, ".gemini", "antigravity-cli", "cache"), { recursive: true });
  writeFileSync(join(home, ".gemini", "antigravity-cli", "conversations", `${agyId}.db`), "");
  writeFileSync(
    join(home, ".gemini", "antigravity-cli", "cache", "last_conversations.json"),
    JSON.stringify({ [cwd]: agyId }),
  );
  writeFileSync(
    join(home, ".gemini", "antigravity-cli", "brain", agyId, ".system_generated", "logs", "transcript.jsonl"),
    JSON.stringify({
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-01-04T00:00:00.000Z",
      content: "<USER_REQUEST>\nShip\n</USER_REQUEST>",
    }),
  );

  const grokDir = join(home, ".grok", "sessions", encodeURIComponent(cwd), "grok-1");
  mkdirSync(grokDir, { recursive: true });
  writeFileSync(
    join(grokDir, "summary.json"),
    JSON.stringify({ info: { id: "grok-1", cwd }, generated_title: "Grok task", updated_at: "2026-01-05T00:01:00.000Z" }),
  );
  writeFileSync(join(grokDir, "updates.jsonl"), "");

  const dshDir = join(home, ".dsh", "sessions", "--work-app--", "dsh-1");
  mkdirSync(dshDir, { recursive: true });
  writeFileSync(
    join(dshDir, "session.v3.jsonl"),
    JSON.stringify({ type: "session", version: 3, id: "dsh-1", createdAt: 1760000000000, cwd }),
  );

  const opts = { cwd, allDirs: false, env, matchLimit: 20 };
  assert.equal(claudeAdapter.discover(opts)[0]?.nativeId, "sess-claude");
  assert.equal(codexAdapter.discover(opts)[0]?.nativeId, "codex-1");
  assert.equal(cursorAdapter.discover(opts)[0]?.nativeId, "cur-1");
  assert.equal(piAdapter.discover(opts)[0]?.nativeId, "pi-1");
  assert.equal(agyAdapter.discover(opts)[0]?.nativeId, agyId);
  assert.equal(grokAdapter.discover(opts)[0]?.nativeId, "grok-1");
  assert.equal(deepseekAdapter.discover(opts)[0]?.nativeId, "dsh-1");
  assert.equal(codexAdapter.discover({ ...opts, cwd: "/somewhere/else" }).length, 0);
});
