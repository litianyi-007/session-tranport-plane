import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { CodexHomeSelection } from "./adapters/types.js";
import type { StpConfig } from "./config.js";
import { StpError, homeDir, normPath } from "./util.js";

export interface CodexEndpoint {
  name: string;
  home: string;
  label?: string;
}

/** Expand `~` and resolve to a comparable absolute path. Does not read the directory. */
export function expandUserPath(input: string, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = input.trim();
  let expanded = trimmed;
  if (trimmed === "~") expanded = homeDir(env);
  else if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    expanded = join(homeDir(env), trimmed.slice(2));
  }
  return normPath(expanded);
}

/** Prefer the real path when the directory exists so symlinks compare equal. */
export function canonicalHome(input: string, env: NodeJS.ProcessEnv = process.env): string {
  const expanded = expandUserPath(input, env);
  try {
    return normPath(realpathSync(expanded));
  } catch {
    return expanded;
  }
}

export function sameHome(a: string, b: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return canonicalHome(a, env) === canonicalHome(b, env);
}

export function displayHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = canonicalHome(homeDir(env), env);
  const target = canonicalHome(home, env);
  if (target === root) return "~";
  if (target.startsWith(root + sep)) return `~${target.slice(root.length)}`;
  return target;
}

export function formatEndpoint(endpoint: CodexEndpoint, env: NodeJS.ProcessEnv = process.env): string {
  const shown = displayHome(endpoint.home, env);
  if (!endpoint.name || endpoint.name === "home") return shown;
  return `${endpoint.name} (${shown})`;
}

/**
 * Active single home when no named profiles are selected.
 * STP_CODEX_HOME wins over CODEX_HOME, which wins over ~/.codex.
 */
export function defaultCodexHome(env: NodeJS.ProcessEnv, tag: boolean): CodexHomeSelection {
  const fromStp = env.STP_CODEX_HOME?.trim();
  const fromCodex = env.CODEX_HOME?.trim();
  const raw = fromStp || fromCodex || join(homeDir(env), ".codex");
  const name = !tag ? "" : fromStp ? "stp" : fromCodex ? "env" : "default";
  return { name, home: canonicalHome(raw, env), configured: false };
}

export function codexHomesForDiscover(input: {
  config: StpConfig;
  env: NodeJS.ProcessEnv;
  profile?: string;
  codexHome?: string;
}): CodexHomeSelection[] {
  if (input.profile && input.codexHome) {
    throw new StpError("Pass either --profile or --codex-home, not both.");
  }
  const configured = materialize(input.config, input.env);
  if (input.profile) {
    const found = configured.find((profile) => profile.name === input.profile);
    if (!found) {
      const names = configured.map((profile) => profile.name);
      const suffix = names.length > 0 ? ` Configured profiles: ${names.join(", ")}.` : " No Codex profiles are configured.";
      throw new StpError(`Unknown Codex profile "${input.profile}".${suffix}`);
    }
    return [found];
  }
  if (input.codexHome) {
    const home = canonicalHome(input.codexHome, input.env);
    const named = configured.find((profile) => sameHome(profile.home, home, input.env));
    return [{ name: named?.name ?? "home", home, label: named?.label, configured: true }];
  }
  if (configured.length === 0) return [defaultCodexHome(input.env, false)];
  const homes = [...configured];
  const active = defaultCodexHome(input.env, true);
  if (!homes.some((profile) => sameHome(profile.home, active.home, input.env))) homes.push(active);
  return dedupe(homes, input.env);
}

export function resolveCodexTarget(input: {
  config: StpConfig;
  env: NodeJS.ProcessEnv;
  intoProfile?: string;
  intoCodexHome?: string;
  source: CodexEndpoint;
}): CodexEndpoint {
  if (input.intoProfile && input.intoCodexHome) {
    throw new StpError("Pass either --into-profile or --into-codex-home, not both.");
  }
  if (input.intoProfile) {
    const found = materialize(input.config, input.env).find((profile) => profile.name === input.intoProfile);
    if (!found) {
      throw new StpError(`Unknown Codex profile "${input.intoProfile}".`);
    }
    return { name: found.name, home: found.home, label: found.label };
  }
  if (input.intoCodexHome) {
    const home = canonicalHome(input.intoCodexHome, input.env);
    const named = materialize(input.config, input.env).find((profile) => sameHome(profile.home, home, input.env));
    return { name: named?.name ?? "home", home, label: named?.label };
  }
  return input.source;
}

export function codexChildEnv(base: NodeJS.ProcessEnv, home: string | undefined): NodeJS.ProcessEnv {
  if (!home) return base;
  return { ...base, CODEX_HOME: home };
}

function materialize(config: StpConfig, env: NodeJS.ProcessEnv): CodexHomeSelection[] {
  return config.profiles
    .filter((profile) => profile.agent === "codex" && profile.home.trim())
    .map((profile) => ({
      name: profile.name,
      home: canonicalHome(profile.home, env),
      label: profile.label,
      configured: true,
    }));
}

function dedupe(homes: CodexHomeSelection[], env: NodeJS.ProcessEnv): CodexHomeSelection[] {
  const seen = new Set<string>();
  const out: CodexHomeSelection[] = [];
  for (const home of homes) {
    const key = canonicalHome(home.home, env);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...home, home: key });
  }
  return out;
}
