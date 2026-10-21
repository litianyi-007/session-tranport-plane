import type { CSIR, CsirEvent, ToolPayload } from "./csir.js";

const PRIVATE_KEY =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const AUTH_HEADER = /\b(Authorization|Proxy-Authorization)\s*:\s*\S+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const KNOWN_TOKENS =
  /\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;
const ASSIGNED_SECRET =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|cookie)\b(\s*[:=]\s*)(\S+)/gi;
const LONG_HEX = /\b[a-fA-F0-9]{48,}\b/g;
const SECRET_KEY = /secret|token|password|authorization|api[_-]?key|cookie/i;

export function redactText(text: string): string {
  return text
    .replace(PRIVATE_KEY, "[REDACTED:private-key]")
    .replace(AUTH_HEADER, "$1: [REDACTED]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(KNOWN_TOKENS, "[REDACTED]")
    .replace(ASSIGNED_SECRET, "$1$2[REDACTED]")
    .replace(LONG_HEX, "[REDACTED:hex]");
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (SECRET_KEY.test(key) && typeof inner === "string") out[key] = "[REDACTED]";
      else out[key] = redactValue(inner);
    }
    return out;
  }
  return value;
}

export function redactCsir(csir: CSIR): CSIR {
  return {
    ...csir,
    events: csir.events.map((event) => redactEvent(event)),
  };
}

function redactEvent(event: CsirEvent): CsirEvent {
  const next: CsirEvent = { ...event };
  if (event.text) next.text = redactText(event.text);
  if (event.tool) next.tool = redactTool(event.tool);
  return next;
}

function redactTool(tool: ToolPayload): ToolPayload {
  const next: ToolPayload = { ...tool, input: redactValue(tool.input) };
  if (tool.output_excerpt) next.output_excerpt = redactText(tool.output_excerpt);
  return next;
}
