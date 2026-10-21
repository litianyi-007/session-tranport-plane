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
}

export interface DiscoverOpts {
  cwd: string;
  allDirs: boolean;
  env: NodeJS.ProcessEnv;
  /** Stop after this many matching sessions. Default 50. */
  matchLimit?: number;
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
}

export interface LaunchPlan {
  argv: string[];
  cwd: string;
  mode: LaunchMode;
  note: string;
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
