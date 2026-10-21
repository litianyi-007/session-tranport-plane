import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { buildCsir, titleFromEvents, type EventDraft } from "../csir.js";
import {
  asObj,
  asStr,
  cwdMatches,
  encodePathDashes,
  envPath,
  homeDir,
  listChildDirs,
  mtimeIso,
  parseJsonl,
  readHead,
  readText,
  textFromContent,
  toIso,
  toolUsesFromContent,
  unwrapUserQuery,
  walkFiles,
} from "../util.js";
import type { AgentAdapter, DiscoverOpts, LaunchOpts, LaunchPlan, SessionRef } from "./types.js";

export function claudeRoot(env: NodeJS.ProcessEnv): string {
  return envPath(env, "CLAUDE_CONFIG_DIR", join(homeDir(env), ".claude"));
}

function projectDirs(opts: DiscoverOpts): string[] {
  const projects = join(claudeRoot(opts.env), "projects");
  if (!opts.allDirs) {
    const encoded = encodePathDashes(opts.cwd);
    const candidates = [join(projects, encoded)];
    if (encoded.startsWith("-")) candidates.push(join(projects, encoded.slice(1)));
    return candidates.filter((dir) => existsSync(dir));
  }
  return listChildDirs(projects);
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  aliases: [],
  summary:
    "Reads Claude Code JSONL transcripts under $CLAUDE_CONFIG_DIR/projects (default ~/.claude/projects/<encoded-cwd>). Native fork delegates to `claude --resume <id> --fork-session`.",
  capabilities: { nativeFork: true, resumeInPlace: true, launchable: true },
  discover(opts) {
    const refs: SessionRef[] = [];
    const limit = opts.matchLimit ?? 50;
    for (const dir of projectDirs(opts)) {
      const files = walkFiles(dir, (file, name) => name.endsWith(".jsonl") && !file.includes(`${join("subagents")}`));
      for (const file of files) {
        if (file.includes("/subagents/")) continue;
        const ref = refFromFile(file, opts);
        if (!ref) continue;
        refs.push(ref);
      }
    }
    return sortRefs(refs).slice(0, limit);
  },
  read(ref) {
    return parseClaudeJsonl(readText(ref.path), ref);
  },
  launch(opts) {
    return launchClaude(opts);
  },
};

function refFromFile(file: string, opts: DiscoverOpts): SessionRef | undefined {
    let head = "";
    try {
      head = readHead(file, 32768);
    } catch {
      return undefined;
    }
  const rows = parseJsonl(head);
  let cwd: string | undefined;
  let created: string | undefined;
  let preview: string | undefined;
  for (const row of rows) {
    const obj = asObj(row);
    if (!obj) continue;
    cwd = cwd ?? asStr(obj.cwd);
    created = created ?? toIso(obj.timestamp);
    if (!preview && (obj.type === "user" || obj.type === "assistant")) {
      const message = asObj(obj.message);
      const text = unwrapUserQuery(textFromContent(message?.content));
      if (text && !isToolResultOnly(message?.content)) preview = text;
    }
  }
  if (!opts.allDirs && cwd && !cwdMatches(cwd, opts.cwd, false)) return undefined;
  if (!opts.allDirs && !cwd) {
    // Directory encoding already scoped the search.
    cwd = opts.cwd;
  }
  if (!cwdMatches(cwd, opts.cwd, opts.allDirs)) return undefined;
  const nativeId = basename(file, ".jsonl");
  return {
    agent: "claude",
    nativeId,
    path: file,
    cwd,
    title: preview ? clip(preview) : undefined,
    preview: preview ? clip(preview) : undefined,
    createdAt: created,
    updatedAt: mtimeIso(file) ?? created,
    launchId: nativeId,
  };
}

export function parseClaudeJsonl(text: string, ref: Pick<SessionRef, "nativeId" | "path" | "cwd" | "updatedAt" | "createdAt">): ReturnType<typeof buildCsir> {
  const events: EventDraft[] = [];
  const pending = new Map<string, number>();
  let cwd = ref.cwd;
  let created = ref.createdAt;
  let nativeId = ref.nativeId;
  for (const row of parseJsonl(text)) {
    const obj = asObj(row);
    if (!obj) continue;
    cwd = cwd ?? asStr(obj.cwd);
    created = created ?? toIso(obj.timestamp);
    nativeId = asStr(obj.sessionId) ?? nativeId;
    const ts = toIso(obj.timestamp);
    const type = asStr(obj.type);
    if (obj.isCompactSummary === true || type === "summary" || asStr(obj.subtype)?.includes("compact")) {
      const message = asObj(obj.message);
      const summary = textFromContent(message?.content) || asStr(obj.summary) || asStr(obj.content) || "";
      events.push({ ts, role: "compact", text: summary || "Compaction boundary", compact_boundary: true });
      continue;
    }
    if (type !== "user" && type !== "assistant") continue;
    const message = asObj(obj.message);
    const content = message?.content;
    if (type === "user" && isToolResultOnly(content)) {
      attachToolResults(events, pending, content, ts);
      continue;
    }
    const textBody = unwrapUserQuery(textFromContent(content));
    if (type === "user") {
      if (!textBody || obj.isMeta === true) continue;
      events.push({ ts, role: "user", text: textBody });
      continue;
    }
    if (textBody && textBody !== "[REDACTED]") {
      events.push({ ts, role: "assistant", text: textBody });
    }
    for (const use of toolUsesFromContent(content)) {
      const draft: EventDraft = {
        ts,
        role: "tool",
        tool: { name: use.name, input: use.input },
      };
      events.push(draft);
      if (use.id) pending.set(use.id, events.length - 1);
    }
  }
  const title = titleFromEvents(
    events.map((event, i) => ({ ...event, i })),
  );
  return buildCsir({
    agent: "claude",
    nativeId,
    cwd,
    createdAt: created,
    updatedAt: ref.updatedAt ?? created,
    title,
    events,
  });
}

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((part) => asObj(part)?.type === "tool_result");
}

function attachToolResults(
  events: EventDraft[],
  pending: Map<string, number>,
  content: unknown,
  ts: string | undefined,
): void {
  if (!Array.isArray(content)) return;
  for (const part of content) {
    const obj = asObj(part);
    if (!obj || obj.type !== "tool_result") continue;
    const id = asStr(obj.tool_use_id);
    const output = textFromContent(obj.content);
    const isError = obj.is_error === true || obj.isError === true;
    const index = id ? pending.get(id) : undefined;
    if (index === undefined) {
      if (isError) {
        events.push({
          ts,
          role: "tool",
          tool: { name: "tool", ok: false, output_excerpt: clip(output, 500) },
        });
      }
      continue;
    }
    const event = events[index];
    if (!event?.tool) continue;
    event.tool = {
      ...event.tool,
      ok: !isError,
      output_excerpt: output ? clip(output, 500) : undefined,
    };
    if (!isError) {
      // Keep successful tools in CSIR so L3 can show them. L2 filters later.
    }
  }
}

function launchClaude(opts: LaunchOpts): LaunchPlan {
  if (opts.mode === "nativeFork" && opts.nativeId) {
    return {
      argv: ["claude", "--resume", opts.nativeId, "--fork-session"],
      cwd: opts.cwd,
      mode: "nativeFork",
      note: "Native fork via Claude Code. The original transcript stays in place; the new process starts a branched session id.",
    };
  }
  if (opts.mode === "resume" && opts.nativeId) {
    return {
      argv: ["claude", "--resume", opts.nativeId],
      cwd: opts.cwd,
      mode: "resume",
      note: "Resume in place via `claude --resume`. This continues the same session.",
    };
  }
  const prompt = opts.prompt ?? "Continue the task described in the handoff seed.";
  return {
    argv: ["claude", prompt],
    cwd: opts.cwd,
    mode: "projection",
    note: "Projection launch. Claude receives a pointer to the seed file, not the original session state.",
  };
}

function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function sortRefs(refs: SessionRef[]): SessionRef[] {
  return refs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
