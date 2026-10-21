import type { CSIR, CsirEvent, Fidelity } from "./csir.js";
import { applyFidelity } from "./csir.js";
import { redactCsir } from "./redact.js";

export function projectHuman(csir: CSIR, fidelity: Fidelity = "L1"): string {
  const view = applyFidelity(redactCsir(csir).events, fidelity);
  const lines: string[] = [];
  const title = csir.session.title || csir.session.native_id;
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`- agent: ${csir.session.agent}`);
  lines.push(`- native id: ${csir.session.native_id}`);
  lines.push(`- stp id: ${csir.session.id}`);
  if (csir.session.cwd) lines.push(`- cwd: ${csir.session.cwd}`);
  if (csir.session.updated_at) lines.push(`- updated: ${csir.session.updated_at}`);
  lines.push(`- fidelity: ${fidelity}`);
  const fp = csir.workspace_fingerprint;
  if (fp) {
    const bits = [
      fp.branch ? `branch ${fp.branch}` : undefined,
      fp.git_head ? `head ${fp.git_head.slice(0, 12)}` : undefined,
      fp.git_dirty === undefined ? undefined : fp.git_dirty ? "dirty" : "clean",
    ].filter(Boolean);
    if (bits.length > 0) lines.push(`- workspace: ${bits.join(", ")}`);
  }
  lines.push("");
  if (view.length === 0) {
    lines.push("_No dialog events in this slice._");
    lines.push("");
    return lines.join("\n");
  }
  for (const event of view) lines.push(...renderEvent(event, "human"), "");
  return lines.join("\n");
}

export function projectAgent(
  csir: CSIR,
  fidelity: Fidelity = "L2",
  extra?: { into?: string },
): string {
  const redacted = redactCsir(csir);
  const view = applyFidelity(redacted.events, fidelity);
  const lines: string[] = [];
  lines.push("# Handoff seed");
  lines.push("");
  lines.push(
    "You are continuing work moved here by Session Transport Plane (stp). This file is a projection of another agent's session. Native tool state, permissions, and KV cache were not transferred.",
  );
  lines.push("");
  lines.push("Before you trust the transcript:");
  lines.push("");
  lines.push("1. Run `git status` and inspect the relevant diff.");
  lines.push("2. Read the key files mentioned below.");
  lines.push("3. Treat failed tool calls as unresolved. Do not assume their side effects landed.");
  lines.push("");
  lines.push(`- source agent: ${csir.session.agent}`);
  lines.push(`- native id: ${csir.session.native_id}`);
  lines.push(`- stp id: ${csir.session.id}`);
  if (csir.session.cwd) lines.push(`- cwd: ${csir.session.cwd}`);
  if (csir.session.title) lines.push(`- title: ${csir.session.title}`);
  lines.push(`- fidelity: ${fidelity}`);
  lines.push(`- lineage: ${csir.session.lineage.mode}`);
  if (extra?.into) lines.push(`- fork into: ${extra.into}`);
  const fp = csir.workspace_fingerprint;
  if (fp) {
    lines.push(
      `- workspace fingerprint: branch=${fp.branch ?? "unknown"} head=${fp.git_head ?? "unknown"} dirty=${String(fp.git_dirty ?? "unknown")}`,
    );
  }
  lines.push("");
  lines.push("## Transcript");
  lines.push("");
  if (view.length === 0) {
    lines.push("_The selected slice has no events._");
    lines.push("");
  } else {
    for (const event of view) lines.push(...renderEvent(event, "agent"), "");
  }
  lines.push("## Continue");
  lines.push("");
  lines.push(
    "Continue the task from the transcript above. Stay in this workspace. If the transcript and the files disagree, trust the files and git.",
  );
  lines.push("");
  return lines.join("\n");
}

function renderEvent(event: CsirEvent, kind: "human" | "agent"): string[] {
  const heading = kind === "human" ? headingHuman(event) : headingAgent(event);
  const lines = [`${kind === "human" ? "##" : "###"} ${heading}`];
  if (event.role === "tool" && event.tool) {
    const tool = event.tool;
    lines.push("");
    lines.push(`- name: ${tool.name}`);
    lines.push(`- ok: ${String(tool.ok)}`);
    if (tool.input !== undefined) {
      const rendered = typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input);
      lines.push(`- input: ${rendered}`);
    }
    if (tool.output_excerpt) lines.push(`- output: ${tool.output_excerpt}`);
    if (event.files_touched?.length) lines.push(`- files: ${event.files_touched.join(", ")}`);
    return lines;
  }
  if (event.text) {
    lines.push("");
    lines.push(event.text);
  }
  if (event.files_touched?.length && event.role !== "tool") {
    lines.push("");
    lines.push(`Files: ${event.files_touched.join(", ")}`);
  }
  return lines;
}

function headingHuman(event: CsirEvent): string {
  switch (event.role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "tool":
      return `Tool ${event.tool?.ok === false ? "failed" : ""}: ${event.tool?.name ?? "tool"}`.replace(
        "  ",
        " ",
      );
    case "compact":
      return "Compact";
    case "system":
      return "System";
    default:
      return event.role;
  }
}

function headingAgent(event: CsirEvent): string {
  if (event.role === "tool" && event.tool?.ok === false) {
    return `Tool failed: ${event.tool.name}`;
  }
  if (event.role === "tool") return `Tool: ${event.tool?.name ?? "tool"}`;
  if (event.role === "compact") return "Compaction boundary";
  return event.role === "user" ? "User" : event.role === "assistant" ? "Assistant" : "System";
}
