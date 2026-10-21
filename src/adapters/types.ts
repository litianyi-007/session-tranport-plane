import type { CSIR } from "../csir.js";

export interface SessionRef {
  agent: string;
  nativeId: string;
  path: string;
  cwd?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  preview?: string;
  /** Set when the native id alone is not enough (for example a pi file path). */
  launchId?: string;
  /** Codex account profile name, when more than one home is in play. */
  profile?: string;
  /** Absolute CODEX_HOME this session was read from. Paths only; never auth material. */
  accountHome?: string;
}

export interface CodexHomeSelection {
  /** Empty when the row should stay untagged (single default home). */
  name: string;
  home: string;
  label?: string;
  configured: boolean;
}

export interface DiscoverOpts {
  cwd: string;
  allDirs: boolean;
  env: NodeJS.ProcessEnv;
  /** Stop after this many matching sessions. Default 50. */
  matchLimit?: number;
  /** When set, Codex discovery scans these homes instead of the single CODEX_HOME. */
  codexHomes?: CodexHomeSelection[];
}

export interface Capabilities {
  nativeFork: boolean;
  resumeInPlace: boolean;
  launchable: boolean;
}

export type LaunchMode = "fresh" | "resume" | "nativeFork" | "projection";

export interface LaunchOpts {
  mode: LaunchMode;
  nativeId?: string;
  seedPath?: string;
  prompt?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Absolute Codex home to expose as CODEX_HOME in the child. */
  codexHome?: string;
}

export interface LaunchPlan {
  argv: string[];
  cwd: string;
  mode: LaunchMode;
  note: string;
  /** Extra environment for the child. Codex launches set only CODEX_HOME. */
  env?: NodeJS.ProcessEnv;
}

export interface AgentAdapter {
  id: string;
  aliases: string[];
  summary: string;
  capabilities: Capabilities;
  discover(opts: DiscoverOpts): SessionRef[];
  read(ref: SessionRef): CSIR;
  launch(opts: LaunchOpts): LaunchPlan;
}
