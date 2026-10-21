import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverAll, findRef, listAdapters, requireAdapter, resolveAdapter } from "./adapters/index.js";
import type { SessionRef } from "./adapters/types.js";
import { loadConfig } from "./config.js";
import { DEFAULT_CONFIG } from "./config.js";
import {
  buildCsir,
  parseCsir,
  serializeCsir,
  sliceEvents,
  withEvents,
  type CSIR,
  type Fidelity,
} from "./csir.js";
import { workspaceFingerprint } from "./fingerprint.js";
import { projectAgent, projectHuman } from "./project.js";
import { redactCsir } from "./redact.js";
import { commandExists, jsonPretty, StpError, stpId } from "./util.js";

const VERSION = "0.1.0";

export interface ParsedArgs {
  command?: "list" | "read" | "fork" | "init" | "help";
  help: boolean;
  version: boolean;
  positionals: string[];
  json: boolean;
  allDirs: boolean;
  agent?: string;
  agentDetail: boolean;
  id?: string;
  last?: number;
  sinceCompact: boolean;
  into?: string;
  fromStdin: boolean;
  dryRun: boolean;
  noLaunch: boolean;
  projection: boolean;
  limit: number;
  fidelity?: Fidelity;
}

const COMMANDS = new Set(["list", "read", "fork", "init", "help"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    version: false,
    positionals: [],
    json: false,
    allDirs: false,
    agentDetail: false,
    sinceCompact: false,
    fromStdin: false,
    dryRun: false,
    noLaunch: false,
    projection: false,
    limit: 20,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === "--") {
      parsed.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === "-h" || token === "--help") {
      parsed.help = true;
      continue;
    }
    if (token === "--version" || token === "-V") {
      parsed.version = true;
      continue;
    }
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--all-dirs") {
      parsed.allDirs = true;
      continue;
    }
    if (token === "--all-agents") continue;
    if (token === "--since-compact") {
      parsed.sinceCompact = true;
      continue;
    }
    if (token === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (token === "--no-launch") {
      parsed.noLaunch = true;
      continue;
    }
    if (token === "--projection") {
      parsed.projection = true;
      continue;
    }
    if (token === "--agent") {
      const next = argv[i + 1];
      const booleanContext = parsed.command === "read" || parsed.command === "fork";
      if (!booleanContext && next && !next.startsWith("-")) {
        parsed.agent = next;
        i += 1;
      } else if (!booleanContext && parsed.command === "list") {
        throw new StpError("--agent requires an agent name");
      }
      parsed.agentDetail = true;
      continue;
    }
    if (token === "--id" || token === "--into" || token === "--from" || token === "--last" || token === "--limit" || token === "--fidelity") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-") && token !== "--from") {
        throw new StpError(`${token} requires a value`);
      }
      i += 1;
      if (token === "--id") parsed.id = value;
      else if (token === "--into") parsed.into = value;
      else if (token === "--from") {
        if (value !== "-") throw new StpError("--from only accepts - (stdin) in Phase 0");
        parsed.fromStdin = true;
      } else if (token === "--last") parsed.last = positiveInt(value, "--last");
      else if (token === "--limit") parsed.limit = positiveInt(value, "--limit");
      else parsed.fidelity = parseFidelity(value);
      continue;
    }
    if (token.startsWith("-")) throw new StpError(`Unknown flag ${token}`);
    if (!parsed.command && COMMANDS.has(token)) {
      parsed.command = token as ParsedArgs["command"];
      continue;
    }
    parsed.positionals.push(token);
  }
  return parsed;
}

function positiveInt(value: string | undefined, flag: string): number {
  if (!value || !/^[1-9]\d*$/.test(value)) throw new StpError(`${flag} expects a positive integer`);
  return Number(value);
}

function parseFidelity(value: string | undefined): Fidelity {
  if (value === "L1" || value === "L2" || value === "L3") return value;
  throw new StpError("--fidelity expects L1, L2, or L3");
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.version && !args.command) {
      process.stdout.write(`stp ${VERSION}\n`);
      return 0;
    }
    if (!args.command || args.command === "help" || (args.help && !args.command)) {
      process.stdout.write(generalHelp());
      return 0;
    }
    if (args.help) {
      process.stdout.write(commandHelp(args.command));
      return 0;
    }
    if (args.command === "list") return runList(args);
    if (args.command === "read") return runRead(args);
    if (args.command === "fork") return runFork(args);
    if (args.command === "init") return runInit(args);
    process.stdout.write(generalHelp());
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`stp: ${message}\n`);
    return error instanceof StpError ? error.exitCode : 1;
  }
}

function runList(args: ParsedArgs): number {
  const cwd = process.cwd();
  const { disabled } = disabledSet(cwd);
  if (args.agent) requireAdapter(args.agent);
  const refs = discoverAll(
    { cwd, allDirs: args.allDirs, env: process.env, matchLimit: Math.max(args.limit, 50) },
    disabled,
    args.agent,
  ).slice(0, args.limit);
  if (args.json) {
    process.stdout.write(jsonPretty(refs.map(toListJson)));
    return 0;
  }
  if (refs.length === 0) {
    const scope = args.allDirs ? "any directory" : cwd;
    const who = args.agent ? requireAdapter(args.agent).id : "known adapters";
    process.stdout.write(`No sessions found for ${who} in ${scope}.\n`);
    return 0;
  }
  process.stdout.write(formatTable(refs));
  return 0;
}

function runRead(args: ParsedArgs): number {
  const name = args.positionals[0];
  if (!name) throw new StpError("stp read requires an agent. Example: stp read codex --since-compact");
  if (args.positionals.length > 1) throw new StpError(`unexpected argument ${args.positionals[1]}`);
  const adapter = requireAdapter(name);
  const cwd = process.cwd();
  const ref = selectRef(adapter.id, args, cwd);
  let csir = finishCsir(adapter.read(ref), ref);
  csir = sliceCsir(csir, args);
  if (args.json) {
    const redacted = redactCsir(csir);
    redacted.policy = {
      ...redacted.policy,
      include_tool_results: "all",
    };
    process.stdout.write(serializeCsir(redacted));
    return 0;
  }
  const fidelity = args.fidelity ?? (args.agentDetail ? "L2" : "L1");
  const markdown = args.agentDetail ? projectAgent(csir, fidelity) : projectHuman(csir, fidelity);
  process.stdout.write(markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return 0;
}

async function runFork(args: ParsedArgs): Promise<number> {
  if (args.positionals.length > 1) throw new StpError(`unexpected argument ${args.positionals[1]}`);
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const fidelity = args.fidelity ?? config.fidelity ?? "L2";
  const loaded = args.fromStdin ? await csirFromStdin(cwd) : csirFromAdapter(args, cwd);
  let csir = sliceCsir(loaded.csir, args);
  const sourceAgent = csir.session.agent;
  const targetName = args.into ?? sourceAgent;
  const target = requireAdapter(targetName);
  const same = target.id === sourceAgent;
  const trimmed = args.sinceCompact || args.last !== undefined;
  let mode: "nativeFork" | "resume" | "projection";
  if (same && !args.projection && !trimmed && target.capabilities.nativeFork && !args.fromStdin) {
    mode = "nativeFork";
  } else if (same && !args.projection && !trimmed && target.capabilities.resumeInPlace && !args.fromStdin) {
    mode = "resume";
  } else {
    mode = "projection";
  }

  const workCwd = csir.session.cwd || cwd;
  let seedPath: string | undefined;
  if (mode === "projection") {
    const stamped = stamp();
    const dir = join(cwd, ".stp", "handoffs", `${stamped}-${safe(sourceAgent)}-to-${safe(target.id)}`);
    mkdirSync(dir, { recursive: true });
    seedPath = join(dir, "agent.md");
    const projected: CSIR = {
      ...csir,
      session: {
        ...csir.session,
        lineage: {
          parent_stp_id: csir.session.id,
          forked_at_event: csir.events.at(-1)?.i ?? null,
          mode: "fork",
        },
      },
    };
    writeFileSync(seedPath, projectAgent(projected, fidelity, { into: target.id }));
    writeFileSync(
      join(dir, "fingerprint.json"),
      jsonPretty({
        kind: "projection-fork",
        parent_stp_id: csir.session.id,
        from: sourceAgent,
        into: target.id,
        native_id: csir.session.native_id,
        fidelity,
        seed: seedPath,
        workspace_fingerprint: csir.workspace_fingerprint ?? null,
      }),
    );
  }

  const prompt = seedPath
    ? [
        "Continue this task from a Session Transport Plane handoff.",
        "",
        "This is a projection, not native session state. First run git status and read the key files, then follow the transcript.",
        "",
        `Seed file: ${seedPath}`,
      ].join("\n")
    : undefined;
  const plan = target.launch({
    mode: mode === "projection" ? "projection" : mode,
    nativeId: loaded.ref?.launchId ?? loaded.ref?.nativeId ?? csir.session.native_id,
    seedPath,
    prompt,
    cwd: workCwd,
    env: process.env,
  });

  process.stdout.write(`kind: ${plan.mode === "nativeFork" ? "native-fork" : plan.mode === "resume" ? "resume-in-place" : "projection"}\n`);
  process.stdout.write(`from: ${sourceAgent} ${csir.session.native_id}\n`);
  process.stdout.write(`into: ${target.id}\n`);
  if (seedPath) process.stdout.write(`seed: ${seedPath}\n`);
  if (plan.argv.length > 0) process.stdout.write(`command: ${plan.argv.map(shellWord).join(" ")}\n`);
  process.stdout.write(`${plan.note}\n`);

  if (args.dryRun || args.noLaunch) return 0;
  if (plan.argv.length === 0) return 0;
  const bin = plan.argv[0];
  if (!bin) return 0;
  if (!commandExists(bin)) {
    const message = `${bin} is not on PATH.`;
    if (mode === "projection") {
      process.stderr.write(`stp: ${message} The seed file is still written.\n`);
      return 0;
    }
    throw new StpError(`${message} Install it or re-run with --projection to write a seed instead.`);
  }
  const child = spawnSync(bin, plan.argv.slice(1), {
    cwd: plan.cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (child.error) throw new StpError(child.error.message);
  return child.status ?? 1;
}

function runInit(args: ParsedArgs): number {
  if (args.positionals.length > 0) throw new StpError("stp init takes no arguments");
  const file = join(process.cwd(), ".stp", "config.toml");
  try {
    mkdirSync(join(process.cwd(), ".stp"), { recursive: true });
    writeFileSync(file, DEFAULT_CONFIG, { flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      process.stdout.write(`${file} already exists\n`);
      return 0;
    }
    throw error;
  }
  process.stdout.write(`Wrote ${file}\n`);
  process.stdout.write("Add .stp/ to .gitignore unless you want handoff seeds committed.\n");
  return 0;
}

function csirFromAdapter(args: ParsedArgs, cwd: string): { csir: CSIR; ref: SessionRef } {
  const hinted = args.positionals[0];
  if (hinted) {
    const adapter = requireAdapter(hinted);
    const ref = selectRef(adapter.id, args, cwd);
    return { csir: finishCsir(adapter.read(ref), ref), ref };
  }
  const { disabled } = disabledSet(cwd);
  const refs = discoverAll({ cwd, allDirs: args.allDirs, env: process.env, matchLimit: 50 }, disabled);
  if (refs.length === 0) {
    throw new StpError("No sessions found in this directory. Pass an agent, --all-dirs, or --from -.");
  }
  const picked = args.id ? matchId(refs, args.id) : refs[0];
  if (!picked) throw new StpError(`No session matches --id ${args.id}`);
  const adapter = requireAdapter(picked.agent);
  return { csir: finishCsir(adapter.read(picked), picked), ref: picked };
}

async function csirFromStdin(cwd: string): Promise<{ csir: CSIR; ref?: SessionRef }> {
  if (process.stdin.isTTY) throw new StpError("--from - needs a CSIR JSON or markdown document on stdin");
  const text = await readStdin();
  if (!text.trim()) throw new StpError("stdin was empty");
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const csir = finishLoose(parseCsir(trimmed), cwd);
    return { csir };
  }
  const csir = buildCsir({
    agent: "stdin",
    nativeId: "stdin",
    cwd,
    title: "Imported transcript",
    events: [{ role: "user", text: trimmed }],
  });
  return { csir: finishLoose(csir, cwd) };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function selectRef(agentId: string, args: ParsedArgs, cwd: string): SessionRef {
  const adapter = requireAdapter(agentId);
  const refs = adapter.discover({
    cwd,
    allDirs: args.allDirs,
    env: process.env,
    matchLimit: 100,
  });
  if (args.id) {
    const found = matchId(refs, args.id);
    if (found) return found;
    if (!args.allDirs) {
      const wider = adapter.discover({ cwd, allDirs: true, env: process.env, matchLimit: 200 });
      const anywhere = matchId(wider, args.id);
      if (anywhere) return anywhere;
    }
    throw new StpError(`No ${adapter.id} session matches --id ${args.id}`);
  }
  const newest = refs[0];
  if (!newest) {
    const scope = args.allDirs ? "any directory" : cwd;
    throw new StpError(`No ${adapter.id} sessions in ${scope}.`);
  }
  return newest;
}

function matchId(refs: SessionRef[], id: string): SessionRef | undefined {
  const direct = findRef(refs, id);
  if (direct) return direct;
  return refs.find((ref) => stpId(ref.agent, ref.nativeId) === id);
}

function finishCsir(csir: CSIR, ref: SessionRef): CSIR {
  const cwd = csir.session.cwd || ref.cwd || process.cwd();
  const fp = workspaceFingerprint(cwd);
  if (!fp) return csir;
  return { ...csir, workspace_fingerprint: fp };
}

function finishLoose(csir: CSIR, cwd: string): CSIR {
  const fp = workspaceFingerprint(csir.session.cwd || cwd);
  if (!fp) return csir;
  return { ...csir, workspace_fingerprint: fp };
}

function sliceCsir(csir: CSIR, args: ParsedArgs): CSIR {
  return withEvents(csir, sliceEvents(csir.events, { sinceCompact: args.sinceCompact, last: args.last }));
}

function disabledSet(cwd: string): { disabled: Set<string> } {
  const config = loadConfig(cwd);
  const disabled = new Set<string>();
  for (const name of config.disabled) {
    disabled.add(resolveAdapter(name)?.id ?? name);
  }
  return { disabled };
}

function toListJson(ref: SessionRef): Record<string, string | undefined> {
  return {
    agent: ref.agent,
    native_id: ref.nativeId,
    stp_id: stpId(ref.agent, ref.nativeId),
    cwd: ref.cwd,
    title: ref.title,
    updated_at: ref.updatedAt,
    path: ref.path,
  };
}

function formatTable(refs: SessionRef[]): string {
  const header = ["AGENT", "UPDATED", "ID", "TITLE"];
  const rows = refs.map((ref) => [
    ref.agent,
    (ref.updatedAt ?? "").replace(/\.\d{3}Z$/, "Z"),
    ref.nativeId,
    ref.title ?? ref.preview ?? "",
  ]);
  const widths = header.map((cell, index) =>
    Math.min(36, Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length))),
  );
  const paint = (row: string[]): string =>
    row
      .map((cell, index) => {
        const width = widths[index] ?? cell.length;
        const shown = cell.length > width ? `${cell.slice(0, width - 1)}…` : cell;
        return shown.padEnd(width);
      })
      .join("  ");
  return [paint(header), ...rows.map(paint)].join("\n") + "\n";
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

function shellWord(word: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function generalHelp(): string {
  const agents = listAdapters()
    .map((adapter) => {
      const aliases = adapter.aliases.length > 0 ? ` (${adapter.aliases.join(", ")})` : "";
      return `  ${adapter.id}${aliases}`;
    })
    .join("\n");
  return `stp ${VERSION} — Session Transport Plane, Phase 0

Usage:
  stp list [options]
  stp read <agent> [options]
  stp fork [agent] [options]
  stp init
  stp --help

List recent local sessions, render one as markdown or CSIR JSON, and fork it.
Same-agent fork uses the tool's native fork or resume when that exists.
Cross-agent fork writes a projection seed (agent.md). It does not move
native session state.

Agents:
${agents}

Run \`stp <command> --help\` for command flags.
Share, clone, the workspace registry, MCP, and IDE plugins are later phases.
`;
}

function commandHelp(command: string): string {
  if (command === "list") {
    return `stp list — recent sessions for this working directory

Usage:
  stp list [--agent <name>] [--all-dirs] [--limit <n>] [--json]

  --agent <name>   One adapter (codex, cursor, pi, agy, grok, deepseek, claude)
  --all-dirs       Do not filter on the current directory
  --limit <n>      How many rows to print (default 20)
  --json           Print CSIR-adjacent session refs as JSON
`;
  }
  if (command === "read") {
    return `stp read — render one session

Usage:
  stp read <agent> [--id <id>] [--last <n>] [--since-compact] [--agent] [--json]
                   [--fidelity L1|L2|L3] [--all-dirs]

  --id <id>        Native id, stp_ id, or transcript path
  --last <n>       Keep the last n user exchanges
  --since-compact  Drop events before the latest compaction boundary
  --agent          Agent markdown (L2: dialog + failed tool calls)
  --json           Print sliced CSIR JSON instead of markdown
  --fidelity       L1 dialog, L2 dialog+failed tools, L3 all parsed tools
  --all-dirs       Search outside the current directory

Without --agent the default rendering is human markdown at L1.
--json keeps every parsed event in the slice, including successful tools,
with secrets redacted.
`;
  }
  if (command === "fork") {
    return `stp fork — continue a session in the same agent or another one

Usage:
  stp fork [agent] [--into <agent>] [--from -] [--id <id>] [--last <n>]
                   [--since-compact] [--fidelity L1|L2|L3] [--projection]
                   [--no-launch] [--dry-run] [--all-dirs]

  --into <agent>   Target. Default: the source agent
  --from -         Read CSIR JSON or markdown from stdin instead of a local session
  --id <id>        Source session
  --last <n>       Seed only the last n user exchanges
  --since-compact  Seed from the latest compaction boundary
  --projection     Force a projection seed even when native fork exists
  --no-launch      Write the seed or print the native command, do not spawn
  --dry-run        Print the plan. Projection seeds are still written
  --fidelity       Default L2 (or fidelity from .stp/config.toml)

Native fork (original session untouched):
  claude --resume <id> --fork-session
  codex fork <id>
  pi --fork <id>
  grok --resume <id> --fork-session

Resume in place (cursor, agy, deepseek) when you do not pass --last,
--since-compact, or --projection. Trimming always uses a projection seed,
because native resume cannot drop history.

Cross-agent fork writes .stp/handoffs/<stamp>-<from>-to-<to>/agent.md
and, when the target is launchable, starts it with a prompt pointing at
that file. The seed tells the target to check git before trusting the
transcript.
`;
  }
  return `stp init — write .stp/config.toml in the current directory

Phase 0 reads adapter on/off switches and the default fidelity from that
file. It does not create a share/clone registry.
`;
}
