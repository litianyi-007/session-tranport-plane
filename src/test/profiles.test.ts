import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexAdapter } from "../adapters/codex.js";
import { loadConfig, parseConfigText } from "../config.js";
import {
  canonicalHome,
  codexChildEnv,
  codexHomesForDiscover,
  defaultCodexHome,
  expandUserPath,
  formatEndpoint,
  resolveCodexTarget,
  sameHome,
} from "../profiles.js";
import { normPath } from "../util.js";

const SENTINEL = "codex-auth-sentinel-marker";

function envFor(home: string): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home };
}

test("codex home precedence expands tilde and prefers STP_CODEX_HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "stp-home-"));
  const env = envFor(home);
  assert.equal(expandUserPath("~", env), normPath(home));
  assert.equal(expandUserPath("~/.codex", env), normPath(join(home, ".codex")));
  mkdirSync(join(home, ".codex"));
  const linked = join(home, "codex-link");
  symlinkSync(join(home, ".codex"), linked);
  assert.equal(sameHome("~/.codex", linked, env), true);
  assert.equal(canonicalHome("~/.codex", env), realpathSync(join(home, ".codex")));

  const implicit = defaultCodexHome(env, false);
  assert.equal(implicit.name, "");
  assert.equal(implicit.home, realpathSync(join(home, ".codex")));

  const fromCodex = defaultCodexHome({ ...env, CODEX_HOME: join(home, "from-codex") }, true);
  assert.equal(fromCodex.name, "env");
  assert.equal(fromCodex.home, normPath(join(home, "from-codex")));

  const fromStp = defaultCodexHome(
    { ...env, CODEX_HOME: join(home, "from-codex"), STP_CODEX_HOME: join(home, "from-stp") },
    true,
  );
  assert.equal(fromStp.name, "stp");
  assert.equal(fromStp.home, normPath(join(home, "from-stp")));
  assert.equal(formatEndpoint({ name: "sub", home: realpathSync(join(home, ".codex")) }, env), "sub (~/.codex)");
  assert.equal(formatEndpoint({ name: "home", home: realpathSync(join(home, ".codex")) }, env), "~/.codex");
});

test("project config overlays global codex profiles", () => {
  const home = mkdtempSync(join(tmpdir(), "stp-cfg-"));
  const cwd = mkdtempSync(join(tmpdir(), "stp-cfg-proj-"));
  const env = envFor(home);
  mkdirSync(join(home, ".stp"), { recursive: true });
  mkdirSync(join(cwd, ".stp"), { recursive: true });
  writeFileSync(
    join(home, ".stp", "config.toml"),
    `
[profiles.codex.sub]
home = "~/.codex"

[profiles.codex.api]
home = "~/.codex-api"
label = "global"

[profiles.codex.skip]
label = "missing home"
`,
  );
  writeFileSync(
    join(cwd, ".stp", "config.toml"),
    `
[profiles.codex.api]
home = "~/.codex-api-project"
label = "project"
`,
  );
  const parsed = parseConfigText(readConfig(join(home, ".stp", "config.toml")));
  assert.equal(parsed.profiles.some((profile) => profile.name === "skip"), false);

  const config = loadConfig(cwd, env);
  const homes = codexHomesForDiscover({ config, env });
  const byName = Object.fromEntries(homes.map((profile) => [profile.name, profile.home]));
  assert.equal(byName.sub, canonicalHome("~/.codex", env));
  assert.equal(byName.api, canonicalHome("~/.codex-api-project", env));
  assert.notEqual(byName.api, canonicalHome("~/.codex-api", env));
  assert.equal(config.profiles.find((profile) => profile.name === "api")?.label, "project");

  const only = codexHomesForDiscover({ config, env, profile: "api" });
  assert.deepEqual(only.map((profile) => profile.name), ["api"]);

  assert.throws(
    () => codexHomesForDiscover({ config, env, profile: "missing" }),
    /Unknown Codex profile "missing"[\s\S]*sub, api/,
  );
  assert.throws(
    () => codexHomesForDiscover({ config, env, profile: "api", codexHome: "~/.codex" }),
    /either --profile or --codex-home/,
  );

  const selected = codexHomesForDiscover({ config, env, codexHome: "~/.codex" });
  assert.equal(selected[0]?.name, "sub");
  assert.equal(selected.length, 1);

  const extra = codexHomesForDiscover({
    config,
    env: { ...env, STP_CODEX_HOME: join(home, ".codex-stp") },
  });
  assert.equal(extra.some((profile) => profile.name === "stp"), true);

  const target = resolveCodexTarget({
    config,
    env,
    intoProfile: "api",
    source: { name: "sub", home: byName.sub ?? "" },
  });
  assert.equal(target.name, "api");
  assert.equal(target.home, byName.api);
  assert.throws(
    () =>
      resolveCodexTarget({
        config,
        env,
        intoProfile: "api",
        intoCodexHome: "~/.codex-api",
        source: { name: "sub", home: byName.sub ?? "" },
      }),
    /either --into-profile or --into-codex-home/,
  );
  const same = resolveCodexTarget({
    config,
    env,
    source: { name: "sub", home: byName.sub ?? "" },
  });
  assert.equal(same.home, byName.sub);
});

test("discovery tags codex profiles and launch sets only CODEX_HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "stp-tag-"));
  const cwd = mkdtempSync(join(tmpdir(), "stp-tag-proj-"));
  const sub = join(home, ".codex");
  const api = join(home, ".codex-api");
  writeRollout(sub, "from-sub", cwd, "2026-04-02T00:00:00.000Z");
  writeRollout(api, "from-api", cwd, "2026-04-01T00:00:00.000Z");
  writeFileSync(join(sub, "auth.json"), JSON.stringify({ token: SENTINEL }));
  writeFileSync(join(api, "auth.json"), JSON.stringify({ token: SENTINEL }));

  const refs = codexAdapter.discover({
    cwd,
    allDirs: false,
    env: envFor(home),
    codexHomes: [
      { name: "sub", home: sub, configured: true },
      { name: "api", home: api, configured: true },
    ],
  });
  assert.deepEqual(
    refs.map((ref) => [ref.nativeId, ref.profile, ref.accountHome]),
    [
      ["from-sub", "sub", sub],
      ["from-api", "api", api],
    ],
  );
  assert.doesNotMatch(JSON.stringify(refs), new RegExp(SENTINEL));
  const csir = codexAdapter.read(refs[0]!);
  assert.doesNotMatch(JSON.stringify(csir), new RegExp(SENTINEL));

  const untagged = codexAdapter.discover({
    cwd,
    allDirs: false,
    env: envFor(home),
    codexHomes: [{ name: "", home: sub, configured: false }],
  });
  assert.equal(untagged[0]?.profile, undefined);
  assert.equal(untagged[0]?.nativeId, "from-sub");

  const projected = codexAdapter.launch({
    mode: "projection",
    cwd,
    env: { CODEX_HOME: sub },
    codexHome: api,
    prompt: "Continue from the handoff seed.",
  });
  assert.equal(projected.mode, "projection");
  assert.deepEqual(projected.env, { CODEX_HOME: api });
  assert.equal(projected.argv[0], "codex");
  assert.notEqual(projected.argv[1], "fork");

  const native = codexAdapter.launch({
    mode: "nativeFork",
    nativeId: "from-sub",
    cwd,
    env: {},
    codexHome: sub,
  });
  assert.deepEqual(native.argv, ["codex", "fork", "from-sub"]);
  assert.deepEqual(native.env, { CODEX_HOME: sub });

  const child = codexChildEnv({ PATH: "/usr/bin", CODEX_HOME: sub }, api);
  assert.equal(child.CODEX_HOME, api);
  assert.equal(child.PATH, "/usr/bin");
  assert.deepEqual(Object.keys(child).sort(), ["CODEX_HOME", "PATH"]);
  assert.equal(codexChildEnv({ PATH: "/usr/bin" }, undefined).CODEX_HOME, undefined);
});

function readConfig(file: string): string {
  return readFileSync(file, "utf8");
}

function writeRollout(home: string, id: string, cwd: string, iso: string): void {
  const [year, month, day] = iso.slice(0, 10).split("-");
  const dir = join(home, "sessions", year ?? "", month ?? "", day ?? "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-${id}.jsonl`),
    [
      JSON.stringify({ timestamp: iso, type: "session_meta", payload: { id, cwd, timestamp: iso } }),
      JSON.stringify({ timestamp: iso, type: "event_msg", payload: { type: "user_message", message: id } }),
    ].join("\n"),
  );
}
