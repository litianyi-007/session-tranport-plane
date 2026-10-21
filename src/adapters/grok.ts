import { existsSync, readdirSync } from "node:fs";
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
  textFromContent,
  toIso,
} from "../util.js";
import type { AgentAdapter, DiscoverOpts, LaunchOpts, LaunchPlan, SessionRef } from "./types.js";

export function grokRoot(env: NodeJS.ProcessEnv): string {
  return envPath(env, "GROK_HOME", join(homeDir(env), ".grok"));
}

interface PendingTool {
  index: number;
  name: string;
}

export const grokAdapter: AgentAdapter = {
  id: "grok",
  aliases: [],
  summary:
    "Reads Grok Build sessions under $GROK_HOME/sessions/<encoded-cwd>/<id>/ (default ~/.grok). summary.json supplies the title; updates.jsonl is the transcript. Native fork delegates to `grok --resume <id> --fork-session`.",
  capabilities: { nativeFork: true, resumeInPlace: true, launchable: true },
  discover(opts) {
    const sessions = join(grokRoot(opts.env), "sessions");
    let groups: string[] = [];
    try {
      groups = readdirSync(sessions).map((name) => join(sessions, name));
    } catch {
      return [];
    }
    const refs: SessionRef[] = [];
    for (const group of groups) {
      const groupCwd = cwdForGroup(group);
      if (!opts.allDirs && groupCwd && !cwdMatches(groupCwd, opts.cwd, false)) continue;
      let children: string[] = [];
      try {
        children = readdirSync(group);
      } catch {
        continue;
      }
      for (const child of children) {
        const dir = join(group, child);
        const summaryPath = join(dir, "summary.json");
        const updates = join(dir, "updates.jsonl");
        if (!existsSync(summaryPath) && !existsSync(updates)) continue;
        const ref = refFromSession(dir, groupCwd, opts);
        if (ref) refs.push(ref);
      }
    }
    return refs
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, opts.matchLimit ?? 50);
  },
  read(ref) {
    const updates = ref.path.endsWith(".jsonl") ? ref.path : join(ref.path, "updates.jsonl");
    const summaryPath = join(ref.path.endsWith(".jsonl") ? join(ref.path, "..") : ref.path, "summary.json");
    const summary = existsSync(summaryPath) ? readSummary(summaryPath) : {};
    return parseGrokUpdates(existsSync(updates) ? readText(updates) : "", {
      ...ref,
      cwd: ref.cwd ?? summary.cwd,
      title: ref.title ?? summary.title,
      createdAt: ref.createdAt ?? summary.createdAt,
      updatedAt: ref.updatedAt ?? summary.updatedAt,
      nativeId: summary.id ?? ref.nativeId,
    }, summary.parentId);
  },
  launch(opts) {
    return launchGrok(opts);
  },
};

function cwdForGroup(group: string): string | undefined {
  const marker = join(group, ".cwd");
  if (existsSync(marker)) {
    try {
      const text = readText(marker).trim();
      if (text) return text;
    } catch {
      // fall through to URL decode
    }
  }
  const name = basename(group);
  try {
    return decodeURIComponent(name);
  } catch {
    return undefined;
  }
}

function readSummary(file: string): {
  id?: string;
  cwd?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  parentId?: string;
} {
  try {
    const obj = asObj(JSON.parse(readText(file)) as unknown);
    if (!obj) return {};
    const info = asObj(obj.info) ?? {};
    return {
      id: asStr(info.id) ?? asStr(obj.id),
      cwd: asStr(info.cwd) ?? asStr(obj.cwd),
      title: asStr(obj.generated_title) ?? asStr(obj.session_summary) ?? asStr(obj.title),
      createdAt: toIso(obj.created_at),
      updatedAt: toIso(obj.updated_at),
      parentId: asStr(obj.parent_session_id),
    };
  } catch {
    return {};
  }
}

function refFromSession(dir: string, groupCwd: string | undefined, opts: DiscoverOpts): SessionRef | undefined {
  const summary = readSummary(join(dir, "summary.json"));
  const cwd = summary.cwd ?? groupCwd;
  if (!cwdMatches(cwd, opts.cwd, opts.allDirs)) return undefined;
  const updates = join(dir, "updates.jsonl");
  const nativeId = summary.id ?? basename(dir);
  return {
    agent: "grok",
    nativeId,
    path: dir,
    cwd,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt ?? mtimeIso(existsSync(updates) ? updates : dir),
    launchId: nativeId,
    preview: summary.title,
  };
}

export function parseGrokUpdates(
  text: string,
  ref: Pick<SessionRef, "nativeId" | "cwd" | "updatedAt" | "createdAt" | "title">,
  parentId?: string,
): ReturnType<typeof buildCsir> {
  const events: EventDraft[] = [];
  let buffer: { role: "user" | "assistant"; parts: string[]; ts?: string } | undefined;
  const pending = new Map<string, PendingTool>();

  const flush = (): void => {
    if (!buffer) return;
    const body = buffer.parts.join("").trim();
    if (body) events.push({ ts: buffer.ts, role: buffer.role, text: body });
    buffer = undefined;
  };

  for (const row of parseJsonl(text)) {
    const obj = asObj(row);
    if (!obj) continue;
    const ts = toIso(obj.timestamp) ?? toIso(asObj(obj._meta)?.agentTimestampMs);
    const params = asObj(obj.params) ?? obj;
    const update = asObj(params.update) ?? params;
    const kind = asStr(update.sessionUpdate) ?? asStr(update.session_update) ?? "";
    if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
      const role = kind.startsWith("user") ? "user" : "assistant";
      const chunk = textFromContent(update.content) || asStr(asObj(update.content)?.text) || "";
      if (!chunk) continue;
      if (!buffer || buffer.role !== role) {
        flush();
        buffer = { role, parts: [chunk], ts };
      } else {
        buffer.parts.push(chunk);
      }
      continue;
    }
    if (kind === "agent_thought_chunk") continue;
    if (kind.includes("compact")) {
      flush();
      const summary = textFromContent(update.content) || asStr(update.summary) || "Context compacted";
      events.push({ ts, role: "compact", text: summary, compact_boundary: true });
      continue;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      flush();
      const id = asStr(update.toolCallId) ?? asStr(update.tool_call_id) ?? `tool_${events.length}`;
      const meta = asObj(asObj(update._meta)?.["x.ai/tool"]);
      const name = asStr(meta?.name) ?? asStr(update.title) ?? asStr(asObj(update.rawInput)?.variant) ?? "tool";
      const status = (asStr(update.status) ?? "").toLowerCase();
      const input = update.rawInput ?? meta?.input ?? {};
      const output = toolOutput(update);
      if (kind === "tool_call" && !pending.has(id)) {
        events.push({
          ts,
          role: "tool",
          files_touched: pathsFromInput(input),
          tool: { name, input, ok: statusToOk(status) },
        });
        pending.set(id, { index: events.length - 1, name });
      }
      const found = pending.get(id);
      if (found) {
        const current = events[found.index];
        if (current?.tool && (status || output)) {
          current.tool = {
            ...current.tool,
            name: current.tool.name === "tool" ? name : current.tool.name,
            ok: status ? statusToOk(status) : current.tool.ok,
            output_excerpt: output ? excerpt(output) : current.tool.output_excerpt,
          };
        }
      } else if (kind === "tool_call_update") {
        events.push({
          ts,
          role: "tool",
          tool: { name, input, ok: statusToOk(status), output_excerpt: output ? excerpt(output) : undefined },
        });
      }
    }
  }
  flush();
  return buildCsir({
    agent: "grok",
    nativeId: ref.nativeId,
    cwd: ref.cwd,
    createdAt: ref.createdAt,
    updatedAt: ref.updatedAt,
    title: ref.title ?? titleFromEvents(events.map((event, i) => ({ ...event, i }))),
    parentNativeId: parentId,
    events,
  });
}

function statusToOk(status: string): boolean | undefined {
  if (!status || status === "in_progress" || status === "pending") return undefined;
  if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") return false;
  if (status === "completed" || status === "success" || status === "ok") return true;
  return undefined;
}

function toolOutput(update: Record<string, unknown>): string {
  const content = update.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const obj = asObj(item);
      if (!obj) continue;
      if (typeof obj.text === "string") parts.push(obj.text);
      const inner = asObj(obj.content);
      if (inner && typeof inner.text === "string") parts.push(inner.text);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  const raw = update.rawOutput;
  if (typeof raw === "string") return raw;
  return "";
}

function launchGrok(opts: LaunchOpts): LaunchPlan {
  if (opts.mode === "nativeFork" && opts.nativeId) {
    return {
      argv: ["grok", "--resume", opts.nativeId, "--fork-session"],
      cwd: opts.cwd,
      mode: "nativeFork",
      note: "Native fork via `grok --resume <id> --fork-session`. The source session stays available.",
    };
  }
  if (opts.mode === "resume" && opts.nativeId) {
    return {
      argv: ["grok", "--resume", opts.nativeId],
      cwd: opts.cwd,
      mode: "resume",
      note: "Resume in place via `grok --resume`.",
    };
  }
  return {
    argv: ["grok", opts.prompt ?? "Continue from the handoff seed."],
    cwd: opts.cwd,
    mode: "projection",
    note: "Projection launch. Grok starts with a prompt that points at the seed file.",
  };
}
