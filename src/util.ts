import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

export class StpError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "StpError";
    this.exitCode = exitCode;
  }
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.HOME || env.USERPROFILE;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return homedir();
}

export function envPath(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string {
  const value = env[name];
  if (value && value.trim()) return value;
  return fallback;
}

/** Non-alphanumeric runs become a single dash. `/work/app` → `-work-app`. */
export function encodePathDashes(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, "-").replace(/-+/g, "-");
}

/**
 * Pi session directory slug: drop the leading separator, replace `/`, `\`,
 * and `:` with `-`, then wrap with `--`.
 */
export function encodePiDir(cwd: string): string {
  const stripped = cwd.replace(/^[/\\]+/, "");
  const body = stripped.replace(/[/\\:]/g, "-");
  return `--${body}--`;
}

export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

export function pathsRelated(a: string, b: string): boolean {
  const na = normPath(a);
  const nb = normPath(b);
  if (na === nb) return true;
  return na.startsWith(nb + sep) || nb.startsWith(na + sep);
}

export function normPath(input: string): string {
  const resolved = isAbsolute(input) ? resolve(input) : resolve(input);
  let out = normalize(resolved);
  if (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1);
  return process.platform === "win32" ? out.toLowerCase() : out;
}

export function cwdMatches(
  sessionCwd: string | undefined,
  requested: string,
  allDirs: boolean,
): boolean {
  if (allDirs) return true;
  if (!sessionCwd) return false;
  return pathsRelated(sessionCwd, requested);
}

export function readText(file: string): string {
  return readFileSync(file, "utf8");
}

export function readHead(file: string, maxBytes = 8192): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function mtimeIso(file: string): string | undefined {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return undefined;
  }
}

export function walkFiles(
  dir: string,
  pred: (file: string, name: string) => boolean,
  limit = 5000,
): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0 && out.length < limit) {
    const current = stack.pop();
    if (!current) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "." || entry.name === ".." || entry.name === ".git") {
        continue;
      }
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && pred(full, entry.name)) {
        out.push(full);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

export function listChildDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

export function asObj(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function asStr(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

export function toIso(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const parsed = new Date(ms);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return undefined;
}

export function parseJsonl(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Skip torn or non-JSON lines. Session files are append-only and
      // sometimes end mid-write.
    }
  }
  return rows;
}

export function stpId(agent: string, nativeId: string): string {
  const digest = createHash("sha256")
    .update(`${agent}\0${nativeId}`)
    .digest("hex")
    .slice(0, 16);
  return `stp_${digest}`;
}

export function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

export function excerpt(text: string, max = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

const TEXT_TYPES = new Set(["text", "output_text", "input_text"]);

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        if (part.trim()) parts.push(part.trim());
        continue;
      }
      const obj = asObj(part);
      if (!obj) continue;
      const type = asStr(obj.type);
      if (type && !TEXT_TYPES.has(type)) continue;
      if (typeof obj.text === "string" && obj.text.trim()) parts.push(obj.text.trim());
    }
    return parts.join("\n").trim();
  }
  const obj = asObj(content);
  if (obj && typeof obj.text === "string") return obj.text.trim();
  return "";
}

export interface LooseToolUse {
  id?: string;
  name: string;
  input: unknown;
}

export function toolUsesFromContent(content: unknown): LooseToolUse[] {
  if (!Array.isArray(content)) return [];
  const uses: LooseToolUse[] = [];
  for (const part of content) {
    const obj = asObj(part);
    if (!obj) continue;
    const type = asStr(obj.type);
    if (type !== "tool_use" && type !== "toolCall" && type !== "tool_call") continue;
    const name = asStr(obj.name) ?? "tool";
    const input = obj.input ?? obj.arguments ?? obj.args ?? {};
    uses.push({ id: asStr(obj.id), name, input });
  }
  return uses;
}

export function pathsFromInput(input: unknown): string[] {
  const obj = asObj(input);
  if (!obj) return [];
  const keys = ["path", "file_path", "filePath", "target_file", "filepath", "target_notebook"];
  const out: string[] = [];
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) out.push(value);
  }
  return out;
}

export function unwrapUserQuery(text: string): string {
  const match = text.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  let body = match ? match[1] : text;
  body = body.replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, "");
  body = body.replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i, "$1");
  const meta = body.search(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/i);
  if (meta >= 0) body = body.slice(0, meta);
  return body.trim();
}

export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathValue = env.PATH ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function firstOnPath(
  names: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of names) {
    if (which(name, env)) return name;
  }
  return undefined;
}

export function commandExists(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return which(command, env) !== undefined;
}

export function tryGit(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch {
    return undefined;
  }
}

export function jsonPretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
