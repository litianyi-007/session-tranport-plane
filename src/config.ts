import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fidelity } from "./csir.js";

export interface StpConfig {
  disabled: Set<string>;
  fidelity?: Fidelity;
}

export function loadConfig(cwd: string): StpConfig {
  const file = join(cwd, ".stp", "config.toml");
  const config: StpConfig = { disabled: new Set() };
  if (!existsSync(file)) return config;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return config;
  }
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
    const value = (kv[2] ?? "").trim().replace(/^"|"$/g, "");
    if (section === "" && key === "fidelity" && (value === "L1" || value === "L2" || value === "L3")) {
      config.fidelity = value;
    }
    if (section === "adapters" && value === "false") config.disabled.add(key);
  }
  return config;
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
`;
