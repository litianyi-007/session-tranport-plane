import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { buildCsir, titleFromEvents, type EventDraft } from "../csir.js";
import {
  asObj,
  asStr,
  cwdMatches,
  encodePiDir,
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

export function dshRoot(env: NodeJS.ProcessEnv): string {
  return envPath(env, "DSH_HOME", join(homeDir(env), ".dsh"));
}

export const deepseekAdapter: AgentAdapter = {
  id: "deepseek",
  aliases: ["dsh"],
  summary:
    "Reads DeepSeek Harness logs under $DSH_HOME/sessions/--<cwd>--/<id>/session*.jsonl (default ~/.dsh). Compressed .jsonl.zstd logs are inflated with Node's zlib zstd decoder. Same-agent resume prints `dsh --profile tui --resume`, which upstream does not ship in the stock web/headless profiles. Projection launch is not offered because dsh has no supported prompt-injection flag.",
  capabilities: { nativeFork: false, resumeInPlace: true, launchable: false },
  discover(opts) {
    const root = join(dshRoot(opts.env), "sessions");
    let groups: string[] = [];
    try {
      groups = readdirSync(root).map((name) => join(root, name));
    } catch {
      return [];
    }
    const preferred = join(root, encodePiDir(opts.cwd));
    const ordered = [preferred, ...groups.filter((group) => group !== preferred)];
    const refs: SessionRef[] = [];
    for (const group of ordered) {
      if (!existsSync(group)) continue;
      let sessions: string[] = [];
      try {
        sessions = readdirSync(group).map((name) => join(group, name));
      } catch {
        continue;
      }
      for (const dir of sessions) {
        const file = pickSessionFile(dir);
        if (!file) continue;
        const ref = refFromFile(file, opts);
        if (ref) refs.push(ref);
      }
      if (!opts.allDirs && refs.length > 0 && group === preferred) break;
    }
    return refs
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, opts.matchLimit ?? 50);
  },
  read(ref) {
    return parseDshLog(readSessionText(ref.path), ref);
  },
  launch(opts) {
    return launchDsh(opts);
  },
};

function pickSessionFile(dir: string): string | undefined {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const files = names.filter((name) => /^session(\.v\d+)?\.jsonl(\.zstd|\.zst)?$/.test(name));
  if (files.length === 0) return undefined;
  const rank = (name: string): number => {
    const version = /\.v(\d+)\./.exec(name);
    const n = version ? Number(version[1]) : 0;
    const compressed = name.endsWith(".zstd") || name.endsWith(".zst") ? 0 : 10;
    return n * 100 + compressed;
  };
  files.sort((a, b) => rank(b) - rank(a));
  const best = files[0];
  return best ? join(dir, best) : undefined;
}

function refFromFile(file: string, opts: DiscoverOpts): SessionRef | undefined {
  let text = "";
  try {
    text = readSessionText(file);
  } catch {
    return undefined;
  }
  const rows = parseJsonl(text.split(/\r?\n/).slice(0, 40).join("\n"));
  const header = asObj(rows[0]);
  const cwd = asStr(header?.cwd);
  if (!cwdMatches(cwd, opts.cwd, opts.allDirs)) return undefined;
  const nativeId = asStr(header?.id) ?? basename(join(file, ".."));
  let title: string | undefined;
  let preview: string | undefined;
  for (const row of rows) {
    const obj = asObj(row);
    if (!obj) continue;
    if (obj.type === "session/title") title = asStr(asObj(obj.data)?.title) ?? title;
    if (!preview && obj.type === "user/message") {
      preview = textFromContent(asObj(obj.data)?.content);
    }
  }
  const created = toIso(header?.createdAt);
  return {
    agent: "deepseek",
    nativeId,
    path: file,
    cwd,
    title: title ?? (preview ? clip(preview) : undefined),
    preview: preview ? clip(preview) : undefined,
    createdAt: created,
    updatedAt: mtimeIso(file) ?? created,
    launchId: nativeId,
  };
}

export function readSessionText(file: string): string {
  if (file.endsWith(".zstd") || file.endsWith(".zst")) {
    const buf = readFileSync(file);
    try {
      return zstdDecompressSync(buf).toString("utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not decompress ${file}: ${message}`);
    }
  }
  return readText(file);
}

export function parseDshLog(
  text: string,
  ref: Pick<SessionRef, "nativeId" | "cwd" | "updatedAt" | "createdAt" | "title">,
): ReturnType<typeof buildCsir> {
  const events: EventDraft[] = [];
  const calls = new Map<string, number>();
  let cwd = ref.cwd;
  let created = ref.createdAt;
  let nativeId = ref.nativeId;
  let title = ref.title;
  for (const row of parseJsonl(text)) {
    const obj = asObj(row);
    if (!obj) continue;
    const type = asStr(obj.type) ?? "";
    const ts = toIso(obj.time) ?? toIso(obj.createdAt);
    const data = asObj(obj.data) ?? {};
    if (type === "session") {
      cwd = asStr(obj.cwd) ?? cwd;
      nativeId = asStr(obj.id) ?? nativeId;
      created = toIso(obj.createdAt) ?? created;
      continue;
    }
    if (type === "session/title") {
      title = asStr(data.title) ?? title;
      continue;
    }
    if (type === "user/message") {
      const body = textFromContent(data.content ?? data.message);
      if (body) events.push({ ts, role: "user", text: body });
      continue;
    }
    if (type === "assistant/message") {
      const content = data.content ?? asObj(data.message)?.content ?? data.message;
      const body = textFromContent(content);
      if (body) events.push({ ts, role: "assistant", text: body });
      continue;
    }
    if (type === "tool/call") {
      const id = asStr(data.callId) ?? `call_${events.length}`;
      const input = parseMaybe(data.arguments);
      events.push({
        ts,
        role: "tool",
        files_touched: pathsFromInput(input),
        tool: { name: asStr(data.name) ?? "tool", input },
      });
      calls.set(id, events.length - 1);
      continue;
    }
    if (type === "tool/result") {
      const message = asObj(data.message) ?? data;
      const isError = message.isError === true || data.error !== undefined;
      const output = textFromContent(message.content) || asStr(asObj(data.error)?.reason) || "";
      const callId = asStr(message.callId) ?? asStr(data.callId);
      const index = callId ? calls.get(callId) : [...calls.values()].at(-1);
      const target = index === undefined ? undefined : events[index];
      if (target?.tool) {
        target.tool = {
          ...target.tool,
          ok: !isError,
          output_excerpt: output ? excerpt(output) : undefined,
        };
      } else if (isError) {
        events.push({
          ts,
          role: "tool",
          tool: { name: "tool", ok: false, output_excerpt: output ? excerpt(output) : undefined },
        });
      }
      continue;
    }
    if (type === "compaction/summary") {
      const summary = textFromContent(data.summary) || "Compaction boundary";
      events.push({ ts, role: "compact", text: summary, compact_boundary: true });
      continue;
    }
    if (type === "compaction/end" && asStr(data.error)) {
      events.push({
        ts,
        role: "compact",
        text: `Compaction failed: ${asStr(data.error)}`,
        compact_boundary: true,
      });
    }
  }
  return buildCsir({
    agent: "deepseek",
    nativeId,
    cwd,
    createdAt: created,
    updatedAt: ref.updatedAt ?? created,
    title: title ?? titleFromEvents(events.map((event, i) => ({ ...event, i }))),
    events,
  });
}

function parseMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function launchDsh(opts: LaunchOpts): LaunchPlan {
  if ((opts.mode === "resume" || opts.mode === "nativeFork") && opts.nativeId) {
    return {
      argv: ["dsh", "--profile", "tui", "--resume", opts.nativeId],
      cwd: opts.cwd,
      mode: "resume",
      note: "DeepSeek Harness has no native fork. STP will try `dsh --profile tui --resume <id>`. Stock dsh builds only ship web and headless profiles, so this command may fail — use a projection seed with --into another agent, or open the session from `dsh web`.",
    };
  }
  return {
    argv: [],
    cwd: opts.cwd,
    mode: "projection",
    note: "DeepSeek Harness cannot be launched with a seed prompt. The agent.md seed is written for you to open manually.",
  };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`;
}
