# stp

Local-first **Session Transport Plane** for coding-agent sessions. Phase 0 lists sessions in the current directory, renders them as markdown or [CSIR](#csir-v01) JSON, and forks them — native fork when the same agent supports it, otherwise a projection seed the next agent can read.

The GitHub repository is named `session-tranport-plane`. That spelling is intentional.

This is not a wrapper around [CatchUp](https://github.com/wilbeibi/catchup). CatchUp's public docs were used as a hint for where some tools store sessions. STP has its own intermediate representation, projectors, and CLI.

## Install

Node.js 20 or newer.

```bash
npm install
npm run build
```

`npm install` also builds, via the `prepare` script. Run the CLI with:

```bash
node dist/cli.js --help
# or, after npm link / npm install -g .
stp --help
```

## Quickstart

From a project directory where you have used one of the supported agents:

```bash
stp list
stp read codex --agent --since-compact
stp fork codex --into pi --since-compact
```

`stp list` only shows sessions whose recorded working directory is the current directory (or a parent/child of it). `stp list --all-dirs` drops that filter. `stp list --agent cursor` limits the adapter.

If the directory has no local sessions, the commands still run and report that nothing was found. To try the readers without a live agent, point the adapter homes at a fixture tree (see [Session locations](#session-locations)) or run `npm test`, which builds temporary sessions for every adapter.

### Read

Human markdown (dialog only, fidelity L1) is the default:

```bash
stp read claude --last 4
stp read cursor --id <native-id>
```

`--agent` switches to the agent seed shape at fidelity L2 (dialog plus **failed** tool calls):

```bash
stp read pi --agent --since-compact
```

`--json` prints sliced CSIR. Successful tool calls stay in the JSON so another `stp fork --from -` can filter them again. Secrets are redacted on the way out.

```bash
stp read grok --json --since-compact | stp fork --into codex --from -
```

### Fork

```bash
stp fork                         # newest session, same agent
stp fork codex                   # native: codex fork <id>
stp fork claude --into codex     # projection seed, then launch codex
stp fork --into pi --from -      # CSIR JSON or markdown on stdin
stp fork cursor --projection     # force a seed even though cursor can resume
stp fork agy --dry-run           # print the plan; projection seeds are still written
```

What runs:

| Situation | What STP does |
| --- | --- |
| Same agent, same Codex home, native fork, no trimming | Delegates. Claude, Codex, Pi, and Grok. The Codex child gets `CODEX_HOME` for that account. |
| Same agent, different Codex home | Projection fork. Native `codex fork` is not used. The child gets the target `CODEX_HOME`. |
| Same agent, resume only, no trimming | Resumes in place and says so. Cursor, Antigravity, DeepSeek Harness. |
| `--last`, `--since-compact`, or `--projection` | Writes a new projection. Native resume cannot drop history. |
| Different `--into` agent | Writes `.stp/handoffs/<stamp>-<from>-to-<to>/agent.md` and starts the target with a prompt that points at that file. |

The seed tells the target to run `git status` and read the files before trusting the transcript. A projection is not native tool state.

`--no-launch` writes the seed (or prints the native command) and does not spawn. If the target binary is missing, a projection fork still leaves the seed on disk.

DeepSeek Harness is not launched with a seed. Its same-agent path prints `dsh --profile tui --resume <id>`, which stock `dsh` builds may reject because only the `web` and `headless` profiles ship. Open the session from `dsh web`, or fork `--into` something else.

### init

```bash
stp init
```

Writes `.stp/config.toml` with the default fidelity (`L2`) and per-adapter switches. Set `codex = false` under `[adapters]` to hide an agent. Phase 0 does not keep a share/clone registry. Add `.stp/` to `.gitignore` unless you mean to commit handoff seeds.

## CSIR v0.1

Canonical Session Intermediate Representation. Adapters normalize into this document; projectors render it.

- `session` — STP id (`stp_` + hash), native id, agent, cwd, timestamps, title, lineage (`root` or `fork` when the source file recorded a parent)
- `policy` — visibility, tool-result policy, reasoning off, redact categories
- `workspace_fingerprint` — `git_head`, `git_dirty`, `branch` when the session directory is a git checkout
- `events` — `user`, `assistant`, `tool`, `system`, `compact`. Tool events carry `name`, `input`, `ok`, and a short `output_excerpt`
- `artifacts` — paths touched by tool inputs, without hashing file contents

Fidelity:

| Level | Contents |
| --- | --- |
| L1 | User and assistant text, plus compaction boundaries |
| L2 | L1 plus tool calls marked failed (default for `fork` and `read --agent`) |
| L3 | L2 plus the other parsed tool calls |

`--since-compact` keeps the latest compact event and everything after it. `--last N` keeps the last N user messages and the events that follow them.

Before a projection is written, STP redacts PEM private keys, `Authorization` / `Bearer` headers, common token prefixes (`sk-`, `ghp_`, `github_pat_`, `xox*`, `AKIA…`), `api_key` / `password` / `token` assignments, and hex strings of 48 characters or more.

## Session locations

Paths below are the ones this build actually probes. Overrides are the tools' own environment variables, plus `CURSOR_HOME` which is an STP discovery root (Cursor itself does not document that variable).

| Agent | ids | Read | Same-agent fork | `--into` launch | Where STP looks |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `claude` | JSONL transcripts | `claude --resume <id> --fork-session` | `claude <prompt>` | `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/*.jsonl` (default `~/.claude`) |
| Codex | `codex` | rollout JSONL (`session_meta`, `event_msg`, `response_item`) | `codex fork <id>` | `codex <prompt>` | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` and `archived_sessions/` |
| Cursor | `cursor` | agent-transcripts JSONL | resume in place: `cursor-agent --resume <id>` (falls back to `agent`) | same binary, new chat | `$CURSOR_HOME/projects/<encoded-cwd>/agent-transcripts/` |
| Pi | `pi`, `pi-agent` | session JSONL, active `parentId` branch | `pi --fork <id>` | `pi <prompt>` | `$PI_CODING_AGENT_SESSION_DIR` or `~/.pi/agent/sessions/--<cwd>--/` |
| Antigravity | `agy`, `antigravity` | `transcript.jsonl` steps | resume: `agy --conversation <id>` | positional prompt, best-effort | `~/.gemini/antigravity-cli/` (`GEMINI_HOME`) |
| Grok Build | `grok` | `updates.jsonl` plus `summary.json` | `grok --resume <id> --fork-session` | `grok <prompt>` | `$GROK_HOME/sessions/<url-encoded-cwd>/<id>/` |
| DeepSeek Harness | `deepseek`, `dsh` | `session.jsonl` / `session.vN.jsonl`, including `.zstd` | `dsh --profile tui --resume <id>` (may be unsupported) | not launchable | `$DSH_HOME/sessions/--<cwd>--/<id>/` |

Encoded cwd forms:

- Claude and Cursor: non-alphanumeric characters become `-` (`/work/app` → `-work-app`)
- Pi and DeepSeek: `--` + path with `/` and `:` turned into `-` + `--` (`--work-app--`)
- Grok: `encodeURIComponent`, or a `.cwd` file when the directory name is a hash slug

### Stubbed or partial

- **Cursor IDE composer DB.** Chats that exist only in `state.vscdb` are not decoded. STP reads the JSONL transcripts under `agent-transcripts` (CLI and Agents window). An `ide:` id is rejected on read with that explanation. Tool results are often absent from those JSONL files; a `turn_ended` status other than success marks the turn's tool calls as failed.
- **Antigravity SQLite trajectories.** `conversations/<uuid>.db` is protobuf. STP uses `brain/<uuid>/.system_generated/logs/transcript.jsonl` and `cache/last_conversations.json` for the cwd. A db with no transcript is skipped on read.
- **DeepSeek compressed logs** use Node's `zlib` zstd decoder (one frame). Uncompressed `session.vN.jsonl` is preferred when both exist. Packed `assistant/chunk` rows are ignored; surface `assistant/message` events are the dialog. Reasoning blocks are dropped.
- **Codex** history changes often. The reader understands `user_message` / `agent_message`, `context_compacted`, `item_completed` (`CommandExecution`, `McpToolCall`, `FileChange`), and `response_item` function calls when those item events are missing. Subagent rollouts are not given a special view.
- **Grok** `chat_history.jsonl` is not read. `updates.jsonl` is the transcript. Thought chunks are skipped.
- **Pi** entries off the active branch are ignored. System prompt messages are not copied into CSIR.
- **Launch flags** for projection mode pass a short prompt that names the seed file. They do not inject the whole transcript through argv. If a CLI ignores a positional prompt, use the seed path printed above the launch.

## Codex multi-account (subscription ↔ API)

A ChatGPT subscription login and an API-key login are different Codex accounts. Each account is a `CODEX_HOME` directory with its own `auth.json` and `sessions/`. STP moves a conversation projection between those directories. Billing and rate limits stay with the account that serves the new thread. STP leaves each `auth.json` in place and only sets `CODEX_HOME` on the launched process.

Create each home and log in once:

```bash
mkdir -p ~/.codex ~/.codex-api
CODEX_HOME=~/.codex codex login
CODEX_HOME=~/.codex-api codex login
```

Name the homes in `~/.stp/config.toml`, the project `.stp/config.toml`, or both. A project file replaces a global profile with the same name.

```toml
[profiles.codex.sub]
home = "~/.codex"
label = "ChatGPT subscription"

[profiles.codex.api]
home = "~/.codex-api"
label = "API key"
```

When any Codex profile is configured, `stp list` and `stp list --agent codex` include sessions from every profile and tag each row with the profile name and home. `--all-profiles` asks for that scan explicitly; it is already the default. `--profile api` limits discovery to one home. With no profiles, the active home is `STP_CODEX_HOME`, then `CODEX_HOME`, then `~/.codex`.

```bash
stp list --agent codex
stp fork codex --profile sub --into-profile api --since-compact
stp fork codex --codex-home ~/.codex --into-codex-home ~/.codex-api --since-compact
```

The cross-account command prints `projection fork: sub (~/.codex) → api (~/.codex-api)`, writes `.stp/handoffs/.../agent.md`, and starts `codex` with `CODEX_HOME` set to the target directory. That directory has to exist before the fork. A fork back into the same home, with no `--last`, `--since-compact`, or `--projection`, still runs `codex fork`.

Single-home precedence is `--codex-home`, then `--profile`, then `STP_CODEX_HOME`, then `CODEX_HOME`, then `~/.codex`. `--profile` and `--codex-home` together are an error, and the same rule applies to `--into-profile` and `--into-codex-home`.

## Phase 0 and later

Phase 0, this package:

- adapters for codex, cursor, pi, agy, grok, deepseek, and claude
- `stp list`, `stp read`, `stp fork`, `stp init`
- CSIR v0.1 and L1/L2/L3 projectors (`human` markdown and `agent.md`)
- `--since-compact`, `--last`, `--from -`
- native fork or resume when the table above says so
- a handoff directory with `agent.md` and `fingerprint.json` for projection forks
- named Codex homes, so a subscription account can hand a projection to an API-key account

Not in this version:

- Phase 1 — `clone`, `share`, claim locks, `.stp/registry.jsonl`, `stp search`
- Phase 2 — MCP, IDE commands, L0 summaries, file watchers, bundles
- Phase 3 — multi-writer shared logs

## Development

```bash
npm test
```

Tests cover CSIR round-trip, both projectors, redact, each adapter parser, discovery under a temporary home, Codex profile resolution and cross-account projection forks, and the CLI help / list / read / fork paths.

## License

MIT.
