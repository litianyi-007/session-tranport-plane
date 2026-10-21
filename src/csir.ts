import { stpId, toIso } from "./util.js";

export const CSIR_VERSION = "0.1" as const;

export type Role = "user" | "assistant" | "tool" | "system" | "compact";

export type LineageMode = "root" | "clone" | "fork" | "share_view";

export type Fidelity = "L1" | "L2" | "L3";

export interface ToolPayload {
  name: string;
  input?: unknown;
  ok?: boolean;
  output_excerpt?: string;
}

export interface CsirEvent {
  i: number;
  ts?: string;
  role: Role;
  text?: string;
  tool?: ToolPayload | null;
  files_touched?: string[];
  compact_boundary?: boolean;
}

export interface WorkspaceFingerprint {
  git_head?: string;
  git_dirty?: boolean;
  branch?: string;
}

export interface CsirArtifact {
  path: string;
  sha256?: string;
  note?: string;
}

export interface CSIR {
  csir_version: typeof CSIR_VERSION;
  session: {
    id: string;
    native_id: string;
    agent: string;
    cwd?: string;
    created_at?: string;
    updated_at?: string;
    title?: string;
    lineage: {
      parent_stp_id: string | null;
      forked_at_event: number | null;
      mode: LineageMode;
    };
  };
  policy: {
    visibility: "private" | "workspace" | "export";
    include_tool_results: "failures_only" | "none" | "all";
    include_reasoning: boolean;
    redact: string[];
  };
  workspace_fingerprint?: WorkspaceFingerprint;
  events: CsirEvent[];
  artifacts?: CsirArtifact[];
}

export interface EventDraft {
  ts?: string;
  role: Role;
  text?: string;
  tool?: ToolPayload | null;
  files_touched?: string[];
  compact_boundary?: boolean;
}

const ROLES = new Set<Role>(["user", "assistant", "tool", "system", "compact"]);

export function reindex(events: EventDraft[]): CsirEvent[] {
  return events.map((event, index) => {
    const next: CsirEvent = { i: index, role: event.role };
    if (event.ts) next.ts = event.ts;
    if (event.text !== undefined && event.text !== "") next.text = event.text;
    if (event.tool !== undefined) next.tool = event.tool;
    if (event.files_touched && event.files_touched.length > 0) {
      next.files_touched = [...new Set(event.files_touched)];
    }
    if (event.compact_boundary || event.role === "compact") next.compact_boundary = true;
    return next;
  });
}

export interface BuildCsirInput {
  agent: string;
  nativeId: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  parentNativeId?: string;
  events: EventDraft[];
  fingerprint?: WorkspaceFingerprint;
}

export function buildCsir(input: BuildCsirInput): CSIR {
  const events = reindex(input.events);
  const parent = input.parentNativeId
    ? stpId(input.agent, input.parentNativeId)
    : null;
  const artifacts = artifactsFromEvents(events);
  const csir: CSIR = {
    csir_version: CSIR_VERSION,
    session: {
      id: stpId(input.agent, input.nativeId),
      native_id: input.nativeId,
      agent: input.agent,
      lineage: {
        parent_stp_id: parent,
        forked_at_event: null,
        mode: parent ? "fork" : "root",
      },
    },
    policy: {
      visibility: "workspace",
      include_tool_results: "failures_only",
      include_reasoning: false,
      redact: ["env", "secrets"],
    },
    events,
  };
  if (input.cwd) csir.session.cwd = input.cwd;
  if (input.createdAt) csir.session.created_at = input.createdAt;
  if (input.updatedAt) csir.session.updated_at = input.updatedAt;
  if (input.title) csir.session.title = input.title;
  if (input.fingerprint) csir.workspace_fingerprint = input.fingerprint;
  if (artifacts.length > 0) csir.artifacts = artifacts;
  return csir;
}

function artifactsFromEvents(events: CsirEvent[]): CsirArtifact[] {
  const seen = new Set<string>();
  const artifacts: CsirArtifact[] = [];
  for (const event of events) {
    for (const path of event.files_touched ?? []) {
      if (seen.has(path)) continue;
      seen.add(path);
      artifacts.push({ path, note: "touched in session" });
    }
  }
  return artifacts;
}

export function titleFromEvents(events: CsirEvent[], fallback?: string): string | undefined {
  const user = events.find((event) => event.role === "user" && event.text?.trim());
  const raw = user?.text?.trim() || fallback?.trim();
  if (!raw) return undefined;
  const flat = raw.replace(/\s+/g, " ");
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

export function sliceEvents(
  events: CsirEvent[],
  opts: { sinceCompact?: boolean; last?: number },
): CsirEvent[] {
  let out = events;
  if (opts.sinceCompact) {
    let boundary = -1;
    for (let i = 0; i < out.length; i += 1) {
      const event = out[i];
      if (event && (event.role === "compact" || event.compact_boundary)) boundary = i;
    }
    if (boundary >= 0) out = out.slice(boundary);
  }
  if (opts.last !== undefined && opts.last > 0) {
    const userIndexes: number[] = [];
    out.forEach((event, index) => {
      if (event.role === "user") userIndexes.push(index);
    });
    if (userIndexes.length > opts.last) {
      const start = userIndexes[userIndexes.length - opts.last] ?? 0;
      out = out.slice(start);
    }
  }
  return reindex(out);
}

export function applyFidelity(events: CsirEvent[], fidelity: Fidelity): CsirEvent[] {
  const kept = events.filter((event) => {
    if (event.role === "user" || event.role === "assistant" || event.role === "compact") {
      return Boolean(event.text?.trim()) || event.role === "compact";
    }
    if (event.role === "tool") {
      if (fidelity === "L1") return false;
      if (fidelity === "L2") return event.tool?.ok === false;
      return true;
    }
    return false;
  });
  return reindex(kept);
}

export function assertCsir(value: unknown): CSIR {
  const obj = asRecord(value, "CSIR");
  if (obj.csir_version !== CSIR_VERSION) {
    throw new Error(`unsupported csir_version: ${String(obj.csir_version)}`);
  }
  const session = asRecord(obj.session, "session");
  if (typeof session.id !== "string" || typeof session.native_id !== "string") {
    throw new Error("session.id and session.native_id are required");
  }
  if (typeof session.agent !== "string") throw new Error("session.agent is required");
  const lineage = asRecord(session.lineage, "session.lineage");
  const mode = lineage.mode;
  if (mode !== "root" && mode !== "clone" && mode !== "fork" && mode !== "share_view") {
    throw new Error("session.lineage.mode is invalid");
  }
  if (!Array.isArray(obj.events)) throw new Error("events must be an array");
  const events: CsirEvent[] = obj.events.map((entry, index) => {
    const event = asRecord(entry, `events[${index}]`);
    const role = event.role;
    if (typeof role !== "string" || !ROLES.has(role as Role)) {
      throw new Error(`events[${index}].role is invalid`);
    }
    const next: CsirEvent = { i: index, role: role as Role };
    const ts = toIso(event.ts) ?? (typeof event.ts === "string" ? event.ts : undefined);
    if (ts) next.ts = ts;
    if (typeof event.text === "string") next.text = event.text;
    if (event.tool === null) next.tool = null;
    if (event.tool && typeof event.tool === "object") {
      const tool = asRecord(event.tool, `events[${index}].tool`);
      if (typeof tool.name !== "string") throw new Error(`events[${index}].tool.name is required`);
      next.tool = {
        name: tool.name,
        input: tool.input,
        ok: typeof tool.ok === "boolean" ? tool.ok : undefined,
        output_excerpt: typeof tool.output_excerpt === "string" ? tool.output_excerpt : undefined,
      };
    }
    if (Array.isArray(event.files_touched)) {
      next.files_touched = event.files_touched.filter((item): item is string => typeof item === "string");
    }
    if (event.compact_boundary === true || role === "compact") next.compact_boundary = true;
    return next;
  });
  const policyRaw = asRecord(obj.policy ?? {}, "policy");
  const csir: CSIR = {
    csir_version: CSIR_VERSION,
    session: {
      id: session.id,
      native_id: session.native_id,
      agent: session.agent,
      cwd: typeof session.cwd === "string" ? session.cwd : undefined,
      created_at: typeof session.created_at === "string" ? session.created_at : undefined,
      updated_at: typeof session.updated_at === "string" ? session.updated_at : undefined,
      title: typeof session.title === "string" ? session.title : undefined,
      lineage: {
        parent_stp_id: typeof lineage.parent_stp_id === "string" ? lineage.parent_stp_id : null,
        forked_at_event:
          typeof lineage.forked_at_event === "number" ? lineage.forked_at_event : null,
        mode,
      },
    },
    policy: {
      visibility:
        policyRaw.visibility === "private" || policyRaw.visibility === "export"
          ? policyRaw.visibility
          : "workspace",
      include_tool_results:
        policyRaw.include_tool_results === "none" || policyRaw.include_tool_results === "all"
          ? policyRaw.include_tool_results
          : "failures_only",
      include_reasoning: policyRaw.include_reasoning === true,
      redact: Array.isArray(policyRaw.redact)
        ? policyRaw.redact.filter((item): item is string => typeof item === "string")
        : ["env", "secrets"],
    },
    events: reindex(events),
  };
  if (obj.workspace_fingerprint && typeof obj.workspace_fingerprint === "object") {
    const fp = asRecord(obj.workspace_fingerprint, "workspace_fingerprint");
    csir.workspace_fingerprint = {
      git_head: typeof fp.git_head === "string" ? fp.git_head : undefined,
      git_dirty: typeof fp.git_dirty === "boolean" ? fp.git_dirty : undefined,
      branch: typeof fp.branch === "string" ? fp.branch : undefined,
    };
  }
  if (Array.isArray(obj.artifacts)) {
    csir.artifacts = obj.artifacts.flatMap((item) => {
      const artifact = asRecord(item, "artifact");
      if (typeof artifact.path !== "string") return [];
      const next: CsirArtifact = { path: artifact.path };
      if (typeof artifact.sha256 === "string") next.sha256 = artifact.sha256;
      if (typeof artifact.note === "string") next.note = artifact.note;
      return [next];
    });
  }
  return csir;
}

export function parseCsir(text: string): CSIR {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CSIR JSON parse failed: ${message}`);
  }
  return assertCsir(value);
}

export function serializeCsir(csir: CSIR): string {
  return `${JSON.stringify(assertCsir(csir), null, 2)}\n`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function withEvents(csir: CSIR, events: CsirEvent[]): CSIR {
  return { ...csir, events: reindex(events) };
}
