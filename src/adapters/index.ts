import { agyAdapter } from "./agy.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { deepseekAdapter } from "./deepseek.js";
import { grokAdapter } from "./grok.js";
import { piAdapter } from "./pi.js";
import type { AgentAdapter, DiscoverOpts, SessionRef } from "./types.js";

export const ADAPTERS: AgentAdapter[] = [
  codexAdapter,
  cursorAdapter,
  piAdapter,
  agyAdapter,
  grokAdapter,
  deepseekAdapter,
  claudeAdapter,
];

const ALIAS: Map<string, AgentAdapter> = new Map();
for (const adapter of ADAPTERS) {
  ALIAS.set(adapter.id, adapter);
  for (const alias of adapter.aliases) ALIAS.set(alias, adapter);
}

export function listAdapters(): AgentAdapter[] {
  return ADAPTERS;
}

export function resolveAdapter(name: string): AgentAdapter | undefined {
  return ALIAS.get(name.trim().toLowerCase());
}

export function knownAgentNames(): string[] {
  return ADAPTERS.map((adapter) => adapter.id);
}

export function discoverAll(
  opts: DiscoverOpts,
  disabled: Set<string> = new Set(),
  only?: string,
): SessionRef[] {
  const selected = only ? [requireAdapter(only)] : ADAPTERS;
  const refs: SessionRef[] = [];
  for (const adapter of selected) {
    if (disabled.has(adapter.id)) continue;
    try {
      refs.push(...adapter.discover(opts));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`stp: ${adapter.id} discover failed: ${message}\n`);
    }
  }
  return refs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export function requireAdapter(name: string): AgentAdapter {
  const adapter = resolveAdapter(name);
  if (!adapter) {
    throw new Error(
      `Unknown agent "${name}". Known agents: ${knownAgentNames().join(", ")}. Aliases: pi-agent, antigravity, dsh.`,
    );
  }
  return adapter;
}

export function findRef(refs: SessionRef[], id: string): SessionRef | undefined {
  const needle = id.trim();
  return refs.find((ref) => ref.nativeId === needle || ref.path === needle || ref.launchId === needle);
}

export type { AgentAdapter, DiscoverOpts, LaunchOpts, LaunchPlan, SessionRef } from "./types.js";
