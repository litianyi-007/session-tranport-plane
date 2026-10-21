import type { WorkspaceFingerprint } from "./csir.js";
import { tryGit } from "./util.js";

export function workspaceFingerprint(cwd: string): WorkspaceFingerprint | undefined {
  const inside = tryGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside !== "true") return undefined;
  const head = tryGit(["rev-parse", "HEAD"], cwd);
  const branch = tryGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const dirty = tryGit(["status", "--porcelain"], cwd);
  const fingerprint: WorkspaceFingerprint = {};
  if (head) fingerprint.git_head = head;
  if (branch) fingerprint.branch = branch;
  if (dirty !== undefined) fingerprint.git_dirty = dirty.length > 0;
  return fingerprint;
}
