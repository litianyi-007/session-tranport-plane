import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFidelity,
  buildCsir,
  parseCsir,
  serializeCsir,
  sliceEvents,
  type CSIR,
} from "../csir.js";
import { projectAgent, projectHuman } from "../project.js";
import { redactText } from "../redact.js";

function sample(): CSIR {
  return buildCsir({
    agent: "codex",
    nativeId: "native-1",
    cwd: "/work/app",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:05:00.000Z",
    title: "Add a test",
    events: [
      { role: "user", text: "Add a test", ts: "2026-01-02T00:00:01.000Z" },
      { role: "assistant", text: "I will add it.", ts: "2026-01-02T00:00:02.000Z" },
      {
        role: "tool",
        ts: "2026-01-02T00:00:03.000Z",
        files_touched: ["src/app.ts"],
        tool: { name: "exec_command", input: { command: "npm test" }, ok: false, output_excerpt: "exit 1" },
      },
      {
        role: "tool",
        ts: "2026-01-02T00:00:04.000Z",
        tool: { name: "exec_command", input: { command: "ls" }, ok: true, output_excerpt: "src" },
      },
      { role: "compact", text: "Test still failing", ts: "2026-01-02T00:00:05.000Z", compact_boundary: true },
      { role: "user", text: "Fix it after compact", ts: "2026-01-02T00:00:06.000Z" },
      { role: "assistant", text: "Bearer sk-secret-token-value and api_key=supersecret", ts: "2026-01-02T00:00:07.000Z" },
    ],
  });
}

test("CSIR JSON round-trips through parse and serialize", () => {
  const original = sample();
  const parsed = parseCsir(serializeCsir(original));
  assert.equal(parsed.csir_version, "0.1");
  assert.equal(parsed.session.agent, "codex");
  assert.equal(parsed.session.native_id, "native-1");
  assert.equal(parsed.session.id, original.session.id);
  assert.equal(parsed.session.lineage.mode, "root");
  assert.equal(parsed.policy.include_tool_results, "failures_only");
  assert.deepEqual(
    parsed.events.map((event) => event.role),
    ["user", "assistant", "tool", "tool", "compact", "user", "assistant"],
  );
  assert.equal(parsed.events[2]?.tool?.ok, false);
  assert.equal(parsed.events[2]?.tool?.name, "exec_command");
  assert.equal(parsed.events[4]?.compact_boundary, true);
  assert.deepEqual(parsed.artifacts, [{ path: "src/app.ts", note: "touched in session" }]);
  const again = parseCsir(serializeCsir(parsed));
  assert.deepEqual(again, parsed);
});

test("slice keeps the compact boundary and the last user exchange", () => {
  const events = sample().events;
  const since = sliceEvents(events, { sinceCompact: true });
  assert.deepEqual(
    since.map((event) => event.text),
    ["Test still failing", "Fix it after compact", "Bearer sk-secret-token-value and api_key=supersecret"],
  );
  const last = sliceEvents(events, { last: 1 });
  assert.equal(last[0]?.text, "Fix it after compact");
  assert.equal(last.at(-1)?.role, "assistant");
});

test("fidelity L1 drops tools and L2 keeps only failures", () => {
  const events = sample().events;
  assert.equal(applyFidelity(events, "L1").some((event) => event.role === "tool"), false);
  const l2 = applyFidelity(events, "L2");
  assert.deepEqual(
    l2.filter((event) => event.role === "tool").map((event) => event.tool?.ok),
    [false],
  );
  assert.equal(applyFidelity(events, "L3").filter((event) => event.role === "tool").length, 2);
});

test("human projector is dialog and agent projector includes the failed tool", () => {
  const csir = sample();
  const human = projectHuman(csir, "L1");
  assert.match(human, /## User/);
  assert.match(human, /Add a test/);
  assert.doesNotMatch(human, /exec_command/);
  assert.match(human, /Bearer \[REDACTED\]/);
  assert.match(human, /api_key=\[REDACTED\]/);

  const agent = projectAgent(csir, "L2", { into: "pi" });
  assert.match(agent, /Tool failed: exec_command/);
  assert.match(agent, /exit 1/);
  assert.match(agent, /fork into: pi/);
  assert.match(agent, /git status/);
  assert.doesNotMatch(agent, /"command":"ls"/);
  assert.match(agent, /projection/i);
});

test("redact strips private keys and long hex tokens", () => {
  const text = [
    "-----BEGIN PRIVATE KEY-----",
    "abc",
    "-----END PRIVATE KEY-----",
    "token " + "ab".repeat(30),
  ].join("\n");
  const cleaned = redactText(text);
  assert.match(cleaned, /\[REDACTED:private-key\]/);
  assert.match(cleaned, /\[REDACTED:hex\]/);
  assert.doesNotMatch(cleaned, /BEGIN PRIVATE KEY/);
});
