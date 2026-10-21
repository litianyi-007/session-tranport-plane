import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
const SENTINEL = "codex-auth-sentinel-marker";

function run(args: string[], extra?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }) {
  const env = { ...process.env, ...(extra?.env ?? {}) };
  for (const key of [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
    "GEMINI_HOME",
    "GROK_HOME",
    "DSH_HOME",
    "CURSOR_HOME",
    "STP_CODEX_HOME",
  ]) {
    if (!extra?.env || !(key in extra.env)) delete env[key];
  }
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: extra?.cwd,
    env,
    input: extra?.input,
    encoding: "utf8",
  });
}

test("help commands describe list, read, and fork", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /stp list/);
  assert.match(help.stdout, /stp read/);
  assert.match(help.stdout, /stp fork/);
  assert.match(help.stdout, /pi-agent/);

  const read = run(["read", "--help"]);
  assert.equal(read.status, 0);
  assert.match(read.stdout, /--since-compact/);
  assert.match(read.stdout, /--agent/);
  assert.match(read.stdout, /--json/);

  const fork = run(["fork", "--help"]);
  assert.equal(fork.status, 0);
  assert.match(fork.stdout, /--into/);
  assert.match(fork.stdout, /--from -/);
  assert.match(fork.stdout, /native fork/i);
});

test("list, read, and fork against a fixture home", () => {
  const home = mkdtempSync(join(tmpdir(), "stp-cli-"));
  const cwd = mkdtempSync(join(tmpdir(), "stp-proj-"));
  const sessionDir = join(home, ".codex", "sessions", "2026", "01", "02");
  mkdirSync(sessionDir, { recursive: true });
  const claudeDir = join(home, ".claude", "projects", encodeDashes(cwd));
  mkdirSync(claudeDir, { recursive: true });
  const rollout = [
    JSON.stringify({
      timestamp: "2026-01-02T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "codex-9", cwd, timestamp: "2026-01-02T00:00:00.000Z" },
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
        item: { type: "CommandExecution", command: "npm test", aggregated_output: "boom", exit_code: 1, status: "failed" },
      },
    }),
    JSON.stringify({
      timestamp: "2026-01-02T00:00:04.000Z",
      type: "event_msg",
      payload: { type: "context_compacted", message: "Still failing" },
    }),
    JSON.stringify({
      timestamp: "2026-01-02T00:00:05.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Fix the failure" },
    }),
  ].join("\n");
  writeFileSync(join(sessionDir, "rollout-2026-01-02T00-00-00-codex-9.jsonl"), rollout);
  writeFileSync(
    join(claudeDir, "sess.jsonl"),
    JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: "sess",
      cwd,
      message: { role: "user", content: "Older claude note" },
    }),
  );

  const env = { HOME: home, USERPROFILE: home };
  const list = run(["list"], { cwd, env });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /codex/);
  assert.match(list.stdout, /codex-9/);
  assert.match(list.stdout, /claude/);
  assert.doesNotMatch(list.stdout, /PROFILE/);

  const listed = run(["list", "--agent", "codex", "--json"], { cwd, env });
  assert.equal(listed.status, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout) as { native_id: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.native_id, "codex-9");

  const human = run(["read", "codex"], { cwd, env });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Add a test/);
  assert.doesNotMatch(human.stdout, /exec_command/);

  const detailed = run(["read", "codex", "--agent", "--since-compact"], { cwd, env });
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.match(detailed.stdout, /Still failing/);
  assert.match(detailed.stdout, /Fix the failure/);
  const detailedTranscript = detailed.stdout.split("## Transcript")[1] ?? "";
  assert.doesNotMatch(detailedTranscript, /Add a test/);
  assert.doesNotMatch(detailedTranscript, /Tool failed/);

  const full = run(["read", "codex", "--agent"], { cwd, env });
  assert.match(full.stdout, /Tool failed: exec_command/);
  assert.match(full.stdout, /boom/);

  const json = run(["read", "codex", "--json", "--last", "1"], { cwd, env });
  assert.equal(json.status, 0, json.stderr);
  const csir = JSON.parse(json.stdout) as { csir_version: string; events: { text?: string }[] };
  assert.equal(csir.csir_version, "0.1");
  assert.equal(csir.events[0]?.text, "Fix the failure");
  assert.equal(csir.events.some((event) => event.text === "Add a test"), false);

  const native = run(["fork", "codex", "--dry-run"], { cwd, env });
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stdout, /kind: native-fork/);
  assert.match(native.stdout, /command: codex fork codex-9/);
  assert.doesNotMatch(native.stdout, /projection fork:/);
  assert.equal(existsSync(join(cwd, ".stp", "handoffs")), false);

  const cross = run(["fork", "codex", "--into", "pi", "--dry-run", "--since-compact"], { cwd, env });
  assert.equal(cross.status, 0, cross.stderr);
  assert.match(cross.stdout, /kind: projection/);
  assert.match(cross.stdout, /into: pi/);
  const seedLine = cross.stdout.split("\n").find((line) => line.startsWith("seed: "));
  assert.ok(seedLine);
  const seed = seedLine.slice("seed: ".length);
  assert.equal(existsSync(seed), true);
  const body = readFileSync(seed, "utf8");
  assert.match(body, /Still failing/);
  assert.match(body, /fork into: pi/);
  assert.match(body, /git status/);
  const transcript = body.split("## Transcript")[1] ?? "";
  assert.doesNotMatch(transcript, /Add a test/);

  const trimmedSame = run(["fork", "codex", "--since-compact", "--no-launch"], { cwd, env });
  assert.match(trimmedSame.stdout, /kind: projection/);
  assert.match(trimmedSame.stdout, /into: codex/);
  assert.doesNotMatch(trimmedSame.stdout, /projection fork:/);

  const piped = run(["fork", "--from", "-", "--into", "claude", "--dry-run"], {
    cwd,
    env,
    input: JSON.stringify(csir),
  });
  assert.equal(piped.status, 0, piped.stderr);
  assert.match(piped.stdout, /kind: projection/);
  assert.match(piped.stdout, /into: claude/);
});

test("init writes config and unknown agents fail", () => {
  const cwd = mkdtempSync(join(tmpdir(), "stp-init-"));
  const first = run(["init"], { cwd, env: { HOME: cwd } });
  assert.equal(first.status, 0, first.stderr);
  assert.match(readFileSync(join(cwd, ".stp", "config.toml"), "utf8"), /fidelity = "L2"/);
  const second = run(["init"], { cwd, env: { HOME: cwd } });
  assert.match(second.stdout, /already exists/);
  const missing = run(["read", "nope"], { cwd, env: { HOME: cwd } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Unknown agent/);
});

test("codex profiles tag every home and project across accounts", () => {
  const home = mkdtempSync(join(tmpdir(), "stp-prof-"));
  const cwd = mkdtempSync(join(tmpdir(), "stp-prof-proj-"));
  const sub = join(home, ".codex");
  const api = join(home, ".codex-api");
  mkdirSync(join(home, ".stp"), { recursive: true });
  writeFileSync(
    join(home, ".stp", "config.toml"),
    [
      "[profiles.codex.sub]",
      'home = "~/.codex"',
      'label = "ChatGPT subscription"',
      "",
      "[profiles.codex.api]",
      'home = "~/.codex-api"',
      'label = "API key"',
      "",
    ].join("\n"),
  );
  writeRollout(sub, "codex-sub-1", cwd, "Ship the subscription thread", "2026-03-02T00:00:00.000Z", true);
  writeRollout(api, "codex-api-1", cwd, "Ship the api thread", "2026-03-01T00:00:00.000Z", false);
  const sentinel = JSON.stringify({ OPENAI_API_KEY: SENTINEL, token: SENTINEL });
  writeFileSync(join(sub, "auth.json"), sentinel);
  writeFileSync(join(api, "auth.json"), sentinel);
  const env = { HOME: home, USERPROFILE: home };

  const list = run(["list", "--agent", "codex", "--json"], { cwd, env });
  assert.equal(list.status, 0, list.stderr);
  const rows = JSON.parse(list.stdout) as { native_id: string; profile?: string; home?: string }[];
  assert.deepEqual(
    rows.map((row) => row.profile).sort(),
    ["api", "sub"],
  );
  assert.equal(rows.find((row) => row.native_id === "codex-sub-1")?.home, realpathSync(sub));
  assert.equal(rows.find((row) => row.native_id === "codex-api-1")?.home, realpathSync(api));
  assert.doesNotMatch(list.stdout, new RegExp(SENTINEL));

  const table = run(["list", "--agent", "codex"], { cwd, env });
  assert.match(table.stdout, /PROFILE/);
  assert.match(table.stdout, /sub \(/);
  assert.match(table.stdout, /api \(/);

  const filtered = run(["list", "--agent", "codex", "--profile", "api", "--json"], { cwd, env });
  assert.equal(filtered.status, 0, filtered.stderr);
  const apiRows = JSON.parse(filtered.stdout) as { native_id: string }[];
  assert.deepEqual(apiRows.map((row) => row.native_id), ["codex-api-1"]);

  const both = run(["list", "--profile", "sub", "--codex-home", sub], { cwd, env });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /either --profile or --codex-home/);

  const unknown = run(["list", "--profile", "missing"], { cwd, env });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown Codex profile "missing"/);
  assert.match(unknown.stderr, /sub, api/);

  const early = run(
    ["fork", "codex", "--profile", "sub", "--into-codex-home", join(home, ".codex-missing"), "--dry-run"],
    { cwd, env },
  );
  assert.equal(early.status, 1);
  assert.match(early.stderr, /does not exist/);
  assert.equal(existsSync(join(cwd, ".stp", "handoffs")), false);

  const cross = run(["fork", "codex", "--profile", "sub", "--into-profile", "api", "--dry-run"], { cwd, env });
  assert.equal(cross.status, 0, cross.stderr);
  assert.match(cross.stdout, /projection fork: sub \(~\/\.codex\) → api \(~\/\.codex-api\)/);
  assert.match(cross.stdout, /kind: projection/);
  assert.match(cross.stdout, /command: codex /);
  assert.doesNotMatch(cross.stdout, /codex fork /);
  assert.match(cross.stdout, new RegExp(`CODEX_HOME=${escapeRegExp(realpathSync(api))}`));
  assert.doesNotMatch(`${cross.stdout}\n${cross.stderr}`, new RegExp(SENTINEL));
  const seedLine = cross.stdout.split("\n").find((line) => line.startsWith("seed: "));
  assert.ok(seedLine);
  const seed = seedLine.slice("seed: ".length);
  const seedBody = readFileSync(seed, "utf8");
  const fingerprint = readFileSync(join(seed, "..", "fingerprint.json"), "utf8");
  assert.match(seedBody, /Ship the subscription thread/);
  assert.doesNotMatch(seedBody, new RegExp(SENTINEL));
  assert.doesNotMatch(fingerprint, new RegExp(SENTINEL));
  assert.match(fingerprint, /"into_profile": "api"/);
  assert.match(fingerprint, /"from_profile": "sub"/);
  assert.doesNotMatch(fingerprint, /auth\.json/);

  const trimmed = run(
    ["fork", "codex", "--profile", "sub", "--into-profile", "api", "--since-compact", "--dry-run"],
    { cwd, env },
  );
  assert.match(trimmed.stdout, /kind: projection/);
  const trimmedSeed = trimmed.stdout.split("\n").find((line) => line.startsWith("seed: "));
  assert.ok(trimmedSeed);
  const trimmedBody = readFileSync(trimmedSeed.slice("seed: ".length), "utf8");
  const trimmedTranscript = trimmedBody.split("## Transcript")[1] ?? "";
  assert.match(trimmedTranscript, /After compact/);
  assert.doesNotMatch(trimmedTranscript, /Ship the subscription thread/);

  const same = run(["fork", "codex", "--profile", "sub", "--into-profile", "sub", "--dry-run"], { cwd, env });
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /kind: native-fork/);
  assert.match(same.stdout, /command: codex fork codex-sub-1/);
  assert.match(same.stdout, new RegExp(`CODEX_HOME=${escapeRegExp(realpathSync(sub))}`));
  assert.doesNotMatch(same.stdout, /projection fork:/);
  assert.doesNotMatch(same.stdout, /^seed: /m);

  const byPath = run(
    ["fork", "codex", "--codex-home", "~/.codex", "--into-codex-home", "~/.codex-api", "--dry-run"],
    { cwd, env },
  );
  assert.equal(byPath.status, 0, byPath.stderr);
  assert.match(byPath.stdout, /projection fork: sub \(~\/\.codex\) → api \(~\/\.codex-api\)/);
  assert.match(byPath.stdout, /kind: projection/);
  assert.match(byPath.stdout, new RegExp(`CODEX_HOME=${escapeRegExp(realpathSync(api))}`));
});

function writeRollout(home: string, id: string, cwd: string, user: string, iso: string, compacted: boolean): void {
  const [year, month, day] = iso.slice(0, 10).split("-");
  const dir = join(home, "sessions", year ?? "", month ?? "", day ?? "");
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: iso, type: "session_meta", payload: { id, cwd, timestamp: iso } }),
    JSON.stringify({ timestamp: iso, type: "event_msg", payload: { type: "user_message", message: user } }),
  ];
  if (compacted) {
    lines.push(
      JSON.stringify({
        timestamp: iso,
        type: "event_msg",
        payload: { type: "context_compacted", message: "Compacted subscription context" },
      }),
      JSON.stringify({
        timestamp: iso,
        type: "event_msg",
        payload: { type: "user_message", message: "After compact" },
      }),
    );
  }
  writeFileSync(join(dir, `rollout-${id}.jsonl`), lines.join("\n"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function encodeDashes(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, "-").replace(/-+/g, "-");
}
