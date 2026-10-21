import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { buildCsir, titleFromEvents, type EventDraft } from "../csir.js";
import {
  asObj,
  asStr,
  cwdMatches,
  encodePathDashes,
  envPath,
  firstOnPath,
  homeDir,
  listChildDirs,
  mtimeIso,
  parseJsonl,
  pathsFromInput,
  readHead,
  readText,
  textFromContent,
  toolUsesFromContent,
  unwrapUserQuery,
  walkFiles,
} from "../util.js";
import type { AgentAdapter, DiscoverOpts, LaunchOpts, LaunchPlan, SessionRef } from "./types.js";

export function cursorRoot(env: NodeJS.ProcessEnv): string {
  return envPath(env, "CURSOR_HOME", join(homeDir(env), ".cursor"));
}

/**
 * Cursor IDE composer rows live in state.vscdb (a VS Code KV database, often
 * with opaque blobs). Phase 0 lists and reads the agent-transcripts JSONL
 * tree, which both the CLI and the Agents window write. Full IDE KV parsing
 * is intentionally not implemented.
 */
export const CURSOR_IDE_TODO =
  "IDE state.vscdb composer history is stubbed. STP reads ~/.cursor/projects/<encoded-cwd>/agent-transcripts JSONL (nested <id>/<id>.jsonl and flat <id>.jsonl). Resume uses `cursor-agent --resume` when that id came from the CLI store; an ide: id is not a native resume key.";

export const cursorAdapter: AgentAdapter = {
  id: "cursor",
  aliases: [],
  summary: `Reads Cursor agent transcripts under $CURSOR_HOME/projects (default ~/.cursor). ${CURSOR_IDE_TODO} Same-agent fork resumes in place.`,
  capabilities: { nativeFork: false, resumeInPlace: true, launchable: true },
  discover(opts) {
    const projects = join(cursorRoot(opts.env), "projects");
    const dirs = opts.allDirs
      ? listChildDirs(projects)
      : encodedCandidates(projects, opts.cwd).filter((dir) => existsSync(dir));
    const refs: SessionRef[] = [];
    for (const dir of dirs) {
      const root = join(dir, "agent-transcripts");
      const files = walkFiles(root, (file, name) => name.endsWith(".jsonl") && !file.includes("/subagents/"), 2000);
      for (const file of files) {
        const ref = refFromTranscript(file, opts, dir);
        if (ref) refs.push(ref);
      }
    }
    return refs
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, opts.matchLimit ?? 50);
  },
  read(ref) {
    if (ref.nativeId.startsWith("ide:")) {
      throw new Error(
        `Cursor IDE session ${ref.nativeId} is not readable in Phase 0. ${CURSOR_IDE_TODO}`,
      );
    }
    return parseCursorJsonl(readText(ref.path), ref);
  },
  launch(opts) {
    return launchCursor(opts);
  },
};

function encodedCandidates(projects: string, cwd: string): string[] {
  const encoded = encodePathDashes(cwd);
  const names = new Set([encoded, encoded.replace(/^-/, "")]);
  return [...names].map((name) => join(projects, name));
}

function refFromTranscript(file: string, opts: DiscoverOpts, projectDir: string): SessionRef | undefined {
  const id = basename(file, ".jsonl");
  if (basename(join(file, "..")) === "subagents") return undefined;
  let head = "";
  try {
    head = readHead(file, 16384);
  } catch {
    return undefined;
  }
  let preview: string | undefined;
  let cwd: string | undefined;
  for (const row of parseJsonl(head)) {
    const obj = asObj(row);
    if (!obj) continue;
    cwd = cwd ?? asStr(obj.cwd);
    if (obj.role === "user") {
      const text = unwrapUserQuery(textFromContent(asObj(obj.message)?.content));
      if (text) {
        preview = text;
        break;
      }
    }
  }
  if (!cwd && !opts.allDirs) cwd = opts.cwd;
  // Project directory encoding is the cwd scope when the file itself has none.
  if (!opts.allDirs && !cwdMatches(cwd, opts.cwd, false)) {
    const encoded = encodePathDashes(opts.cwd);
    const dirName = basename(projectDir);
    if (dirName !== encoded && dirName !== encoded.replace(/^-/, "")) return undefined;
    cwd = opts.cwd;
  }
  if (!cwdMatches(cwd, opts.cwd, opts.allDirs)) return undefined;
  const updated = mtimeIso(file);
  return {
    agent: "cursor",
    nativeId: id,
    path: file,
    cwd,
    title: preview ? clip(preview) : id,
    preview: preview ? clip(preview) : undefined,
    updatedAt: updated,
    createdAt: updated,
    launchId: id,
  };
}

export function parseCursorJsonl(
  text: string,
  ref: Pick<SessionRef, "nativeId" | "cwd" | "updatedAt" | "createdAt">,
): ReturnType<typeof buildCsir> {
  const events: EventDraft[] = [];
  let turnTools: number[] = [];
  for (const row of parseJsonl(text)) {
    const obj = asObj(row);
    if (!obj) continue;
    if (obj.type === "turn_ended") {
      const status = asStr(obj.status)?.toLowerCase();
      if (status && status !== "success" && status !== "completed") {
        for (const index of turnTools) {
          const event = events[index];
          if (event?.tool && event.tool.ok === undefined) {
            event.tool = {
              ...event.tool,
              ok: false,
              output_excerpt: event.tool.output_excerpt ?? `turn ended with status ${status}`,
            };
          }
        }
      }
      turnTools = [];
      continue;
    }
    const role = asStr(obj.role);
    if (role !== "user" && role !== "assistant") continue;
    const content = asObj(obj.message)?.content ?? obj.content;
    if (role === "user") {
      turnTools = [];
      const textBody = unwrapUserQuery(textFromContent(content));
      if (textBody) events.push({ role: "user", text: textBody });
      continue;
    }
    const textBody = textFromContent(content);
    if (textBody && textBody !== "[REDACTED]") events.push({ role: "assistant", text: textBody });
    for (const use of toolUsesFromContent(content)) {
      events.push({
        role: "tool",
        files_touched: pathsFromInput(use.input),
        tool: { name: use.name, input: use.input },
      });
      turnTools.push(events.length - 1);
    }
  }
  const updated = ref.updatedAt;
  return buildCsir({
    agent: "cursor",
    nativeId: ref.nativeId,
    cwd: ref.cwd,
    createdAt: ref.createdAt ?? updated,
    updatedAt: updated,
    title: titleFromEvents(events.map((event, i) => ({ ...event, i }))),
    events,
  });
}

function launchCursor(opts: LaunchOpts): LaunchPlan {
  const bin = firstOnPath(["cursor-agent", "agent"], opts.env) ?? "cursor-agent";
  if ((opts.mode === "resume" || opts.mode === "nativeFork") && opts.nativeId) {
    return {
      argv: [bin, "--resume", opts.nativeId],
      cwd: opts.cwd,
      mode: "resume",
      note: "Cursor has no native fork. STP resumes the same CLI session in place with `cursor-agent --resume` (or `agent --resume`). IDE-only composer ids are not resumed this way.",
    };
  }
  return {
    argv: [bin, opts.prompt ?? "Continue from the handoff seed."],
    cwd: opts.cwd,
    mode: "projection",
    note: "Projection launch. The target starts a new Cursor CLI chat pointed at the seed file.",
  };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`;
}
