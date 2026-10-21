import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { buildCsir, titleFromEvents, type EventDraft } from "../csir.js";
import {
  asObj,
  asStr,
  cwdMatches,
  encodePiDir,
  envPath,
  excerpt,
  homeDir,
  listChildDirs,
  mtimeIso,
  parseJsonl,
  pathsFromInput,
  readHead,
  readText,
  textFromContent,
  toolUsesFromContent,
  toIso,
} from "../util.js";
import type { AgentAdapter, DiscoverOpts, LaunchOpts, LaunchPlan, SessionRef } from "./types.js";

export function piSessionsRoot(env: NodeJS.ProcessEnv): string {
  if (env.PI_CODING_AGENT_SESSION_DIR && env.PI_CODING_AGENT_SESSION_DIR.trim()) {
    return env.PI_CODING_AGENT_SESSION_DIR;
  }
  const agent = envPath(env, "PI_CODING_AGENT_DIR", join(homeDir(env), ".pi", "agent"));
  return join(agent, "sessions");
}

interface PiEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  name?: string;
  summary?: string;
  firstKeptEntryId?: string;
  parentSession?: string;
  message?: Record<string, unknown>;
  content?: unknown;
  customType?: string;
}

export const piAdapter: AgentAdapter = {
  id: "pi",
  aliases: ["pi-agent"],
  summary:
    "Reads Pi coding-agent JSONL under $PI_CODING_AGENT_SESSION_DIR or ~/.pi/agent/sessions/--<cwd>--/. Follows the active parentId branch and keeps compaction summaries. Native fork delegates to `pi --fork <id>`.",
  capabilities: { nativeFork: true, resumeInPlace: true, launchable: true },
  discover(opts) {
    const root = piSessionsRoot(opts.env);
    const dirs = opts.allDirs ? listChildDirs(root) : [join(root, encodePiDir(opts.cwd))].concat(listChildDirs(root));
    const seen = new Set<string>();
    const refs: SessionRef[] = [];
    for (const dir of dirs) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const files = listJsonl(dir);
      for (const file of files) {
        const ref = refFromFile(file, opts);
        if (ref) refs.push(ref);
      }
    }
    return refs
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, opts.matchLimit ?? 50);
  },
  read(ref) {
    return parsePiJsonl(readText(ref.path), ref);
  },
  launch(opts) {
    return launchPi(opts);
  },
};

function listJsonl(dir: string): string[] {
  return listChildFiles(dir).filter((file) => file.endsWith(".jsonl"));
}

function listChildFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function refFromFile(file: string, opts: DiscoverOpts): SessionRef | undefined {
  let head = "";
  try {
    head = readHead(file, 4096);
  } catch {
    return undefined;
  }
  const first = asObj(parseJsonl(head)[0]);
  if (!first || first.type !== "session") return undefined;
  const cwd = asStr(first.cwd);
  if (!cwdMatches(cwd, opts.cwd, opts.allDirs)) return undefined;
  const nativeId = asStr(first.id) ?? basename(file, ".jsonl");
  const created = toIso(first.timestamp);
  return {
    agent: "pi",
    nativeId,
    path: file,
    cwd,
    createdAt: created,
    updatedAt: mtimeIso(file) ?? created,
    launchId: nativeId,
    title: nativeId,
  };
}

export function parsePiJsonl(
  text: string,
  ref: Pick<SessionRef, "nativeId" | "cwd" | "updatedAt" | "createdAt" | "path">,
): ReturnType<typeof buildCsir> {
  const entries: PiEntry[] = [];
  for (const row of parseJsonl(text)) {
    const obj = asObj(row);
    if (obj) entries.push(obj as PiEntry);
  }
  const header = entries.find((entry) => entry.type === "session");
  const cwd = asStr(header?.cwd) ?? ref.cwd;
  const nativeId = asStr(header?.id) ?? ref.nativeId;
  const created = toIso(header?.timestamp) ?? ref.createdAt;
  const parentFile = asStr(header?.parentSession);
  const parentNativeId = parentFile ? idFromPiPath(parentFile) : undefined;
  const active = activeBranch(entries);
  let title: string | undefined;
  const events: EventDraft[] = [];
  for (const entry of active) {
    const ts = toIso(entry.timestamp);
    if (entry.type === "session_info" && asStr(entry.name)) title = asStr(entry.name);
    if (entry.type === "compaction") {
      events.push({
        ts,
        role: "compact",
        text: asStr(entry.summary) ?? "Compaction boundary",
        compact_boundary: true,
      });
      continue;
    }
    if (entry.type === "custom_message") {
      const body = textFromContent(entry.content);
      if (body) events.push({ ts, role: "system", text: body });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message ?? {};
    const role = asStr(message.role);
    if (role === "system") continue;
    if (role === "user") {
      const body = textFromContent(message.content);
      if (body) events.push({ ts, role: "user", text: body });
      continue;
    }
    if (role === "assistant") {
      const body = textFromContent(message.content);
      if (body) events.push({ ts, role: "assistant", text: body });
      for (const use of toolUsesFromContent(message.content)) {
        events.push({
          ts,
          role: "tool",
          files_touched: pathsFromInput(use.input),
          tool: { name: use.name, input: use.input },
        });
      }
      continue;
    }
    if (role === "toolResult" || role === "tool") {
      const name = asStr(message.toolName) ?? "tool";
      const isError = message.isError === true || message.is_error === true;
      const output = textFromContent(message.content);
      const callId = asStr(message.toolCallId);
      const match = callId
        ? [...events].reverse().find((event) => event.role === "tool" && event.tool?.name === name && event.tool.ok === undefined)
        : undefined;
      if (match?.tool) {
        match.tool = { ...match.tool, ok: !isError, output_excerpt: output ? excerpt(output) : undefined };
      } else if (isError || output) {
        events.push({
          ts,
          role: "tool",
          tool: { name, ok: !isError, output_excerpt: output ? excerpt(output) : undefined },
        });
      }
    }
  }
  const titled = title ?? titleFromEvents(events.map((event, i) => ({ ...event, i })));
  return buildCsir({
    agent: "pi",
    nativeId,
    cwd,
    createdAt: created,
    updatedAt: ref.updatedAt ?? created,
    title: titled,
    parentNativeId,
    events,
  });
}

function activeBranch(entries: PiEntry[]): PiEntry[] {
  const nodes = entries.filter((entry) => entry.type !== "session" && entry.id);
  if (nodes.length === 0) return [];
  const byId = new Map(nodes.map((entry) => [entry.id as string, entry]));
  const parents = new Set(nodes.map((entry) => entry.parentId).filter((id): id is string => Boolean(id)));
  const leaves = nodes.filter((entry) => entry.id && !parents.has(entry.id));
  const leaf = leaves.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))[0] ?? nodes[nodes.length - 1];
  const path: PiEntry[] = [];
  const guard = new Set<string>();
  let current: PiEntry | undefined = leaf;
  while (current && current.id && !guard.has(current.id)) {
    guard.add(current.id);
    path.push(current);
    const parentId: string | null | undefined = current.parentId;
    current = parentId ? byId.get(parentId) : undefined;
  }
  path.reverse();
  return path;
}

function idFromPiPath(file: string): string | undefined {
  const name = basename(file, ".jsonl");
  const split = name.split("_");
  const tail = split[split.length - 1];
  return tail || undefined;
}

function launchPi(opts: LaunchOpts): LaunchPlan {
  if (opts.mode === "nativeFork" && opts.nativeId) {
    return {
      argv: ["pi", "--fork", opts.nativeId],
      cwd: opts.cwd,
      mode: "nativeFork",
      note: "Native fork via `pi --fork`. Pi copies the session into a new file for this project.",
    };
  }
  if (opts.mode === "resume" && opts.nativeId) {
    return {
      argv: ["pi", "--session", opts.nativeId],
      cwd: opts.cwd,
      mode: "resume",
      note: "Resume via `pi --session`. This continues the same session file.",
    };
  }
  return {
    argv: ["pi", opts.prompt ?? "Continue from the handoff seed."],
    cwd: opts.cwd,
    mode: "projection",
    note: "Projection launch. Pi starts a new session with the handoff prompt.",
  };
}
