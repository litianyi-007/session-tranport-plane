import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { buildCsir, titleFromEvents, type EventDraft } from "../csir.js";
import {
  asObj,
  asStr,
  cwdMatches,
  envPath,
  excerpt,
  homeDir,
  mtimeIso,
  parseJsonl,
  pathsFromInput,
  readText,
  toIso,
  unwrapUserQuery,
} from "../util.js";
import type { AgentAdapter, DiscoverOpts, LaunchOpts, LaunchPlan, SessionRef } from "./types.js";

export function agyRoot(env: NodeJS.ProcessEnv): string {
  const gemini = envPath(env, "GEMINI_HOME", join(homeDir(env), ".gemini"));
  return join(gemini, "antigravity-cli");
}

const HOUSEKEEPING = new Set(["CONVERSATION_HISTORY", "EPHEMERAL_MESSAGE"]);

export const agyAdapter: AgentAdapter = {
  id: "agy",
  aliases: ["antigravity"],
  summary:
    "Reads Antigravity transcripts at ~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl. Conversation SQLite files are enumerated for ids and mtimes; protobuf step blobs are not decoded. Cwd filtering uses cache/last_conversations.json plus any cwd field on a transcript step. Same-agent fork resumes with `agy --conversation <id>`.",
  capabilities: { nativeFork: false, resumeInPlace: true, launchable: true },
  discover(opts) {
    const root = agyRoot(opts.env);
    const convDir = join(root, "conversations");
    const cwdById = invertLastConversations(join(root, "cache", "last_conversations.json"));
    let names: string[] = [];
    try {
      names = readdirSync(convDir).filter((name) => name.endsWith(".db"));
    } catch {
      names = [];
    }
    const refs: SessionRef[] = [];
    for (const name of names) {
      const id = basename(name, ".db");
      const db = join(convDir, name);
      const transcript = transcriptPath(root, id);
      const mapped = cwdById.get(id);
      let cwd = mapped;
      let preview: string | undefined;
      let created: string | undefined;
      if (existsSync(transcript)) {
        const parsed = scanTranscript(transcript);
        cwd = cwd ?? parsed.cwd;
        preview = parsed.preview;
        created = parsed.created;
      }
      if (!cwd && !opts.allDirs) continue;
      if (!cwdMatches(cwd, opts.cwd, opts.allDirs)) continue;
      const updated = mtimeIso(existsSync(transcript) ? transcript : db);
      refs.push({
        agent: "agy",
        nativeId: id,
        path: existsSync(transcript) ? transcript : db,
        cwd,
        title: preview ? clip(preview) : id,
        preview: preview ? clip(preview) : undefined,
        createdAt: created,
        updatedAt: updated ?? created,
        launchId: id,
      });
    }
    return refs
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, opts.matchLimit ?? 50);
  },
  read(ref) {
    if (!ref.path.endsWith(".jsonl")) {
      throw new Error(
        `Antigravity conversation ${ref.nativeId} has a SQLite trajectory at ${ref.path} but no transcript.jsonl. Phase 0 does not decode protobuf step blobs.`,
      );
    }
    return parseAgyTranscript(readText(ref.path), ref);
  },
  launch(opts) {
    return launchAgy(opts);
  },
};

function transcriptPath(root: string, id: string): string {
  return join(root, "brain", id, ".system_generated", "logs", "transcript.jsonl");
}

function invertLastConversations(file: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(file)) return map;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const obj = asObj(parsed);
    if (!obj) return map;
    for (const [cwd, id] of Object.entries(obj)) {
      if (typeof id === "string") map.set(id, cwd);
    }
  } catch {
    return map;
  }
  return map;
}

function scanTranscript(file: string): { cwd?: string; preview?: string; created?: string } {
  let text = "";
  try {
    text = readText(file);
  } catch {
    return {};
  }
  let cwd: string | undefined;
  let preview: string | undefined;
  let created: string | undefined;
  for (const row of parseJsonl(text)) {
    const step = asObj(row);
    if (!step) continue;
    created = created ?? toIso(step.created_at);
    cwd = cwd ?? asStr(step.cwd) ?? asStr(step.workspace);
    const source = asStr(step.source) ?? "";
    if (!preview && (source === "USER_EXPLICIT" || source === "USER")) {
      const body = unwrapUserQuery(asStr(step.content) ?? "");
      if (body) preview = body;
    }
  }
  return { cwd, preview, created };
}

export function parseAgyTranscript(
  text: string,
  ref: Pick<SessionRef, "nativeId" | "cwd" | "updatedAt" | "createdAt">,
): ReturnType<typeof buildCsir> {
  const events: EventDraft[] = [];
  let cwd = ref.cwd;
  let created = ref.createdAt;
  for (const row of parseJsonl(text)) {
    const step = asObj(row);
    if (!step) continue;
    const ts = toIso(step.created_at);
    created = created ?? ts;
    cwd = cwd ?? asStr(step.cwd) ?? asStr(step.workspace);
    const stepType = asStr(step.type) ?? "";
    if (HOUSEKEEPING.has(stepType)) continue;
    if (stepType.toLowerCase().includes("compact")) {
      const summary = unwrapUserQuery(asStr(step.content) ?? "") || "Compaction boundary";
      events.push({ ts, role: "compact", text: summary, compact_boundary: true });
      continue;
    }
    const source = asStr(step.source) ?? "";
    const role = roleForSource(source);
    if (!role) continue;
    const raw = asStr(step.content) ?? "";
    const body = role === "user" ? unwrapUserQuery(raw) : raw.trim();
    const tools = toolCalls(step);
    const status = (asStr(step.status) ?? "").toLowerCase();
    const failed = status === "error" || status === "failed" || status === "cancelled";
    if (body && role !== "system") events.push({ ts, role, text: body });
    for (const tool of tools) {
      events.push({
        ts,
        role: "tool",
        files_touched: pathsFromInput(tool.input),
        tool: {
          name: tool.name,
          input: tool.input,
          ok: failed ? false : status === "done" || status === "ok" || status === "success" ? true : undefined,
          output_excerpt: failed ? excerpt(asStr(step.error) ?? status) : undefined,
        },
      });
    }
  }
  return buildCsir({
    agent: "agy",
    nativeId: ref.nativeId,
    cwd,
    createdAt: created,
    updatedAt: ref.updatedAt ?? created,
    title: titleFromEvents(events.map((event, i) => ({ ...event, i }))),
    events,
  });
}

function roleForSource(source: string): "user" | "assistant" | "system" | undefined {
  if (source === "USER_EXPLICIT" || source === "USER") return "user";
  if (source === "MODEL") return "assistant";
  if (source === "SYSTEM") return "system";
  return undefined;
}

function toolCalls(step: Record<string, unknown>): { name: string; input: unknown }[] {
  const raw = step.tool_calls ?? step.toolCalls;
  if (!Array.isArray(raw)) return [];
  const out: { name: string; input: unknown }[] = [];
  for (const item of raw) {
    const obj = asObj(item);
    if (!obj) continue;
    out.push({
      name: asStr(obj.name) ?? "tool",
      input: obj.args ?? obj.arguments ?? obj.input ?? {},
    });
  }
  return out;
}

function launchAgy(opts: LaunchOpts): LaunchPlan {
  if ((opts.mode === "resume" || opts.mode === "nativeFork") && opts.nativeId) {
    return {
      argv: ["agy", "--conversation", opts.nativeId],
      cwd: opts.cwd,
      mode: "resume",
      note: "Antigravity has no native fork. STP resumes the same conversation with `agy --conversation <id>`.",
    };
  }
  return {
    argv: ["agy", opts.prompt ?? "Continue from the handoff seed."],
    cwd: opts.cwd,
    mode: "projection",
    note: "Projection launch. `agy` is started with the handoff prompt as a positional argument (best-effort; the CLI may ignore unknown positionals — the seed file is still written).",
  };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`;
}
