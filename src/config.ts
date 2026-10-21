import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fidelity } from "./csir.js";
import { homeDir } from "./util.js";

export interface CodexProfileConfig {
  agent: "codex";
  name: string;
  /** Path as written in config. Expanded later against the process env. */
  home: string;
  label?: string;
}

export interface StpConfig {
  disabled: Set<string>;
  fidelity?: Fidelity;
  profiles: CodexProfileConfig[];
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): StpConfig {
  const config: StpConfig = { disabled: new Set(), profiles: [] };
  applyFile(config, join(homeDir(env), ".stp", "config.toml"));
  applyFile(config, join(cwd, ".stp", "config.toml"));
  return config;
}

function applyFile(config: StpConfig, file: string): void {
  if (!existsSync(file)) return;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const parsed = parseConfigText(text);
  if (parsed.fidelity) config.fidelity = parsed.fidelity;
  for (const name of parsed.disabled) config.disabled.add(name);
  for (const profile of parsed.profiles) {
    const index = config.profiles.findIndex((item) => item.agent === profile.agent && item.name === profile.name);
    if (index >= 0) config.profiles[index] = profile;
    else config.profiles.push(profile);
  }
}

export function parseConfigText(text: string): StpConfig {
  const config: StpConfig = { disabled: new Set(), profiles: [] };
  const drafts = new Map<string, { agent: "codex"; name: string; home?: string; label?: string }>();
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]?.trim() ?? "";
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] ?? "";
    const value = unquote((kv[2] ?? "").trim());
    if (section === "" && key === "fidelity" && (value === "L1" || value === "L2" || value === "L3")) {
      config.fidelity = value;
    }
    if (section === "adapters" && value === "false") config.disabled.add(key);
    const profileHeader = /^profiles\.codex\.([A-Za-z0-9_-]+)$/.exec(section);
    if (profileHeader && (key === "home" || key === "label")) {
      const name = profileHeader[1] ?? "";
      const draft = drafts.get(name) ?? { agent: "codex" as const, name };
      if (key === "home" && value) draft.home = value;
      if (key === "label" && value) draft.label = value;
      drafts.set(name, draft);
    }
  }
  for (const draft of drafts.values()) {
    if (!draft.home) continue;
    config.profiles.push({
      agent: "codex",
      name: draft.name,
      home: draft.home,
      label: draft.label,
    });
  }
  return config;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export const DEFAULT_CONFIG = `# STP Phase 0
# Handoff seeds land in .stp/handoffs/. This file does not record a
# share/clone registry (that is Phase 1). Add .stp/ to .gitignore unless
# you intend to commit redacted seeds.

fidelity = "L2"

[adapters]
claude = true
codex = true
cursor = true
pi = true
agy = true
grok = true
deepseek = true

# Codex accounts are separate CODEX_HOME directories. Create each one and
# log in once. STP projects the conversation; it does not copy auth.json.
#
# [profiles.codex.sub]
# home = "~/.codex"
# label = "ChatGPT subscription"
#
# [profiles.codex.api]
# home = "~/.codex-api"
# label = "API key"
`;
