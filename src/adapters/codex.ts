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
  readHead,
  readText,
  textFromContent,
  toIso,
  walkFiles,
} from "../util.js";
import type { AgentAdapter, CodexHomeSelection, DiscoverOpts, LaunchOpts, LaunchPlan, SessionRef } from "./types.js";

export function codexRoot(env: NodeJS.ProcessEnv): string {
  return envPath(env, "CODEX_HOME", join(homeDir(env), ".codex"));
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  aliases: [],
  summary:
    "Reads Codex CLI rollout JSONL under each CODEX_HOME (default ~/.codex, or every [profiles.codex.*] home). Native fork delegates to `codex fork <id>` only when the source and target homes match. Archived sessions are included.",
  capabilities: { nativeFork: true, resumeInPlace: true, launchable: true },
  discover(opts) {
    const homes = opts.codexHomes && opts.codexHomes.length > 0
      ? opts.codexHomes
      : [{ name: "", home: codexRoot(opts.env), configured: false }];
    const limit = opts.matchLimit ?? 50;
    const refs: SessionRef[] = [];
    for (const home of homes) {
      refs.push(...discoverHome(home, opts, limit));
    }
    return refs
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, limit);
  },
  read(ref) {
    return parseCodexRollout(readText(ref.path), ref);
  },
  launch(opts) {
    return launchCodex(opts);
  },
};

function discoverHome(home: CodexHomeSelection, opts: DiscoverOpts, limit: number): SessionRef[] {
  const files = [
    ...rolloutFiles(join(home.home, "sessions")),
    ...rolloutFiles(join(home.home, "archived_sessions")),
  ];
  const ranked = files
    .map((file) => ({ file, mtime: mtimeIso(file) ?? "" }))
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  const refs: SessionRef[] = [];
  const scanCap = opts.allDirs ? 3000 : 2000;
  for (const item of ranked.slice(0, scanCap)) {
    const ref = refFromRollout(item.file, item.mtime, opts);
    if (!ref) continue;
    if (home.name) {
      ref.profile = home.name;
      ref.accountHome = home.home;
    }
    refs.push(ref);
    if (refs.length >= limit) break;
  }
  return refs;
}

function rolloutFiles(root: string): string[] {
  return walkFiles(root, (_file, name) => name.startsWith("rollout-") && name.endsWith(".jsonl"), 8000);
}

function refFromRollout(file: string, mtime: string, opts: DiscoverOpts): SessionRef | undefined {
  let head = "";
  try {
    head = readHead(file, 16384);
  } catch {
    return undefined;
  }
  const first = parseJsonl(head)[0];
  const obj = asObj(first);
  const payload = asObj(obj?.payload) ?? obj;
  if (!payload) return undefined;
  const cwd = asStr(payload.cwd);
  if (!cwdMatches(cwd, opts.cwd, opts.allDirs)) return undefined;
  const nativeId = asStr(payload.id) ?? asStr(payload.session_id) ?? idFromName(file);
  let preview: string | undefined;
  for (const row of parseJsonl(head)) {
    const line = asObj(row);
    const body = asObj(line?.payload);
    if (line?.type === "event_msg" && body?.type === "user_message") {
      const text = asStr(body.message);
      if (text) {
        preview = text;
        break;
      }
    }
  }
  const created = toIso(payload.timestamp);
  return {
    agent: "codex",
    nativeId,
    path: file,
    cwd,
    title: preview ? clip(preview) : undefined,
    preview: preview ? clip(preview) : undefined,
    createdAt: created,
    updatedAt: mtime || created,
    launchId: nativeId,
  };
}

export function parseCodexRollout(
  text: string,
  ref: Pick<SessionRef, "nativeId" | "cwd" | "updatedAt" | "createdAt">,
): ReturnType<typeof buildCsir> {
  const lines = parseJsonl(text).map((row) => asObj(row)).filter((row): row is Record<string, unknown> => Boolean(row));
  const hasUserEvent = lines.some((line) => asObj(line.payload)?.type === "user_message" && line.type === "event_msg");
  const hasAgentEvent = lines.some((line) => asObj(line.payload)?.type === "agent_message" && line.type === "event_msg");
  const hasItemTools = lines.some((line) => {
    const item = asObj(asObj(line.payload)?.item);
    const kind = asStr(item?.type);
    return kind === "CommandExecution" || kind === "McpToolCall" || kind === "FileChange";
  });

  let cwd = ref.cwd;
  let created = ref.createdAt;
  let nativeId = ref.nativeId;
  let parent: string | undefined;
  const events: EventDraft[] = [];
  const calls = new Map<string, number>();

  for (const line of lines) {
    const ts = toIso(line.timestamp);
    const payload = asObj(line.payload) ?? {};
    if (line.type === "session_meta") {
      cwd = asStr(payload.cwd) ?? cwd;
      created = toIso(payload.timestamp) ?? created;
      nativeId = asStr(payload.id) ?? nativeId;
      parent = asStr(payload.forked_from_id) ?? asStr(payload.parent_thread_id) ?? parent;
      continue;
    }
    if (line.type === "event_msg") {
      const kind = asStr(payload.type);
      if (kind === "user_message") {
        const message = asStr(payload.message);
        if (message) events.push({ ts, role: "user", text: message });
        continue;
      }
      if (kind === "agent_message") {
        const phase = asStr(payload.phase);
        if (phase === "commentary" || phase === "reasoning") continue;
        const message = asStr(payload.message);
        if (message) events.push({ ts, role: "assistant", text: message });
        continue;
      }
      if (kind === "context_compacted" || kind === "compacted") {
        const summary = asStr(payload.message) ?? asStr(payload.summary) ?? "Context compacted";
        events.push({ ts, role: "compact", text: summary, compact_boundary: true });
        continue;
      }
      if (kind === "item_completed") {
        pushItem(events, asObj(payload.item), ts, hasUserEvent, hasAgentEvent);
      }
      continue;
    }
    if (line.type === "compacted" || line.type === "context_compacted") {
      const summary = asStr(payload.summary) ?? asStr(payload.message) ?? "Context compacted";
      events.push({ ts, role: "compact", text: summary, compact_boundary: true });
      continue;
    }
    if (line.type === "response_item" && !hasItemTools) {
      pushResponseItem(events, calls, payload, ts, hasUserEvent, hasAgentEvent);
    }
  }

  return buildCsir({
    agent: "codex",
    nativeId,
    cwd,
    createdAt: created,
    updatedAt: ref.updatedAt ?? created,
    title: titleFromEvents(events.map((event, i) => ({ ...event, i }))),
    parentNativeId: parent,
    events,
  });
}

function pushItem(
  events: EventDraft[],
  item: Record<string, unknown> | undefined,
  ts: string | undefined,
  hasUserEvent: boolean,
  hasAgentEvent: boolean,
): void {
  if (!item) return;
  const kind = asStr(item.type);
  if (kind === "UserMessage" && !hasUserEvent) {
    const text = textFromContent(item.content) || asStr(item.text);
    if (text) events.push({ ts, role: "user", text });
    return;
  }
  if (kind === "AgentMessage" && !hasAgentEvent) {
    const text = asStr(item.text) || textFromContent(item.content);
    if (text) events.push({ ts, role: "assistant", text });
    return;
  }
  if (kind === "CommandExecution") {
    const exit = typeof item.exit_code === "number" ? item.exit_code : undefined;
    const status = asStr(item.status)?.toLowerCase();
    const failed = exit !== undefined ? exit !== 0 : status === "failed" || status === "error";
    const output = asStr(item.aggregated_output) ?? asStr(item.output) ?? "";
    events.push({
      ts,
      role: "tool",
      text: asStr(item.command),
      tool: {
        name: "exec_command",
        input: { command: item.command, cwd: item.cwd },
        ok: status || exit !== undefined ? !failed : undefined,
        output_excerpt: output ? excerpt(output) : undefined,
      },
    });
    return;
  }
  if (kind === "McpToolCall") {
    const result = item.result;
    const error = item.error;
    const output = typeof result === "string" ? result : result ? JSON.stringify(result) : asStr(error) ?? "";
    events.push({
      ts,
      role: "tool",
      tool: {
        name: asStr(item.tool) ?? "mcp",
        input: { server: item.server, arguments: item.arguments },
        ok: error ? false : true,
        output_excerpt: output ? excerpt(output) : undefined,
      },
    });
    return;
  }
  if (kind === "FileChange") {
    const changes = asObj(item.changes);
    const files = changes ? Object.keys(changes) : pathsFromInput(item);
    events.push({
      ts,
      role: "tool",
      files_touched: files,
      tool: {
        name: "apply_patch",
        input: item.changes ?? {},
        ok: true,
        output_excerpt: asStr(item.stderr) ? excerpt(asStr(item.stderr) ?? "") : undefined,
      },
    });
  }
}

function pushResponseItem(
  events: EventDraft[],
  calls: Map<string, number>,
  payload: Record<string, unknown>,
  ts: string | undefined,
  hasUserEvent: boolean,
  hasAgentEvent: boolean,
): void {
  const kind = asStr(payload.type);
  if (kind === "message") {
    const role = asStr(payload.role);
    const text = textFromContent(payload.content);
    if (!text) return;
    if (role === "user" && !hasUserEvent && !looksLikeCodexPreamble(text)) {
      events.push({ ts, role: "user", text: unwrapMaybe(text) });
    } else if ((role === "assistant" || role === undefined) && !hasAgentEvent) {
      events.push({ ts, role: "assistant", text });
    }
    return;
  }
  if (kind === "function_call" || kind === "custom_tool_call") {
    const id = asStr(payload.call_id) ?? asStr(payload.id) ?? `call_${events.length}`;
    const name = asStr(payload.name) ?? "tool";
    const input = parseMaybeJson(payload.arguments ?? payload.input);
    events.push({
      ts,
      role: "tool",
      files_touched: pathsFromInput(input),
      tool: { name, input },
    });
    calls.set(id, events.length - 1);
    return;
  }
  if (kind === "function_call_output" || kind === "custom_tool_call_output") {
    const id = asStr(payload.call_id) ?? asStr(payload.id);
    const output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "");
    const failed = /error|failed|exit code (?!0)\d+/i.test(output);
    const index = id ? calls.get(id) : undefined;
    if (index === undefined || !events[index]?.tool) {
      events.push({
        ts,
        role: "tool",
        tool: { name: "tool", ok: !failed, output_excerpt: excerpt(output) },
      });
      return;
    }
    const current = events[index];
    if (!current?.tool) return;
    current.tool = { ...current.tool, ok: !failed, output_excerpt: excerpt(output) };
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function looksLikeCodexPreamble(text: string): boolean {
  return text.includes("<environment_context>") || text.includes("<permissions instructions>") || text.length > 8000;
}

function unwrapMaybe(text: string): string {
  const match = text.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  return (match?.[1] ?? text).trim();
}

function idFromName(file: string): string {
  const name = basename(file, ".jsonl");
  const match = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match?.[0] ?? name;
}

function launchCodex(opts: LaunchOpts): LaunchPlan {
  const env = opts.codexHome ? { CODEX_HOME: opts.codexHome } : undefined;
  if (opts.mode === "nativeFork" && opts.nativeId) {
    return {
      argv: ["codex", "fork", opts.nativeId],
      cwd: opts.cwd,
      mode: "nativeFork",
      note: "Native fork via `codex fork`. The source rollout is left unchanged.",
      env,
    };
  }
  if (opts.mode === "resume" && opts.nativeId) {
    return {
      argv: ["codex", "resume", opts.nativeId],
      cwd: opts.cwd,
      mode: "resume",
      note: "Resume in place via `codex resume`. Later turns append to the same thread.",
      env,
    };
  }
  return {
    argv: ["codex", opts.prompt ?? "Continue from the handoff seed."],
    cwd: opts.cwd,
    mode: "projection",
    note: "Projection launch. Codex starts a fresh thread seeded with the handoff prompt. Native session state was not copied.",
    env,
  };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`;
}
