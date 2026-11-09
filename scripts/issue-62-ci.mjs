// Issue #62's hosted-runner boundary. No relay/economic policy lives here.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const MAX_PROJECTS = 3; // One baseline, one policy run, one hosted transaction run.
const PUBLIC_COMPOSE_KEYS = [
  "PACTAGENT_HOSTED_WSS_HOSTNAME", "PACTAGENT_HOSTED_BIND", "PACTAGENT_HOSTED_WSS_PORT",
  "PACTAGENT_HOSTED_CADDYFILE", "PACTAGENT_ACCEPTANCE_MINT_PORT",
  "PACTAGENT_RELAY_PROVIDER_AUTHORS", "PACTAGENT_RELAY_REQUESTER_AUTHORS",
  "PACTAGENT_RELAY_AUTHORITY_AUTHORS", "PACTAGENT_RELAY_LEGACY_GIFT_IDS",
];
export const PHASES = Object.freeze({
  install: [240, "ci"],
  unit: [120, "run", "test:relay-policy"],
  baseline: [180, "run", "test:relay-policy:baseline"],
  relay: [420, "run", "test:relay-policy:live"],
  build: [300, "run", "build", "--", "--webpack"],
  hosted: [420, "run", "test:hosted-nostr:live"],
});

export function ciEnvironment(source, root = ROOT) {
  if (!/^\d+$/.test(source.GITHUB_RUN_ID ?? "") || !/^\d+$/.test(source.GITHUB_RUN_ATTEMPT ?? "") ||
    !source.RUNNER_TEMP || !isAbsolute(source.RUNNER_TEMP)) throw new Error("Missing hosted-runner identity");
  const home = resolve(source.RUNNER_TEMP, "pactagent-62-home");
  // Deliberate allowlist: no GITHUB_TOKEN, cloud/SSH credentials, Docker remote
  // context, npm authentication, application URLs/keys or deployment tokens.
  const env = {
    PATH: source.PATH, HOME: home, TMPDIR: source.RUNNER_TEMP,
    CI: "true", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=1536",
    DOCKER_CONFIG: resolve(home, ".docker"), NPM_CONFIG_USERCONFIG: resolve(home, ".npmrc"),
    NPM_CONFIG_CACHE: resolve(home, ".npm"),
    PACTAGENT_ECONOMIC_MODE: "demo", PACTAGENT_REQUESTER_DECISION_MODE: "deterministic",
    PACTAGENT_ACCEPTANCE_PROJECT_PREFIX: `pactagent-62-ci-${source.GITHUB_RUN_ID}-${source.GITHUB_RUN_ATTEMPT}`,
    PACTAGENT_ACCEPTANCE_RESOURCE_JOURNAL: resolve(root, ".local/issue-62-ci/resources.json"),
  };
  // setup-python's interpreter may need its hosted-toolcache shared library.
  if (source.LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = source.LD_LIBRARY_PATH;
  return env;
}

function journalPath(env, root) {
  const path = resolve(root, ".local/issue-62-ci/resources.json");
  if (env.PACTAGENT_ACCEPTANCE_RESOURCE_JOURNAL !== path) throw new Error("Unexpected resource journal path");
  return path;
}

export function validateProject(entry, env, root = ROOT) {
  const prefix = env.PACTAGENT_ACCEPTANCE_PROJECT_PREFIX;
  if (!/^pactagent-62-ci-\d+-\d+$/.test(prefix ?? "") ||
    typeof entry.project !== "string" || !entry.project.startsWith(prefix + "-") ||
    !/^-(?:hosted|baseline)-[a-z0-9-]+$/.test(entry.project.slice(prefix.length))) throw new Error("Unowned Compose project");
  const expected = entry.project.startsWith(prefix + "-baseline-")
    ? [resolve(root, ".local", entry.project, "compose.json")]
    : [resolve(root, "compose.hosted.yml"), resolve(root, "local/compose.hosted-acceptance.yml")];
  if (!Array.isArray(entry.files) || JSON.stringify(entry.files) !== JSON.stringify(expected) ||
    !entry.env || Object.keys(entry.env).some(key => !PUBLIC_COMPOSE_KEYS.includes(key)) ||
    Object.values(entry.env).some(value => typeof value !== "string")) throw new Error("Invalid cleanup record");
  return entry;
}

function readJournal(path) {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(65537);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 65536) throw new Error("Resource journal exceeded bound");
    const entries = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (!Array.isArray(entries) || entries.length > MAX_PROJECTS) throw new Error("Invalid resource journal");
    return entries;
  } finally { closeSync(fd); }
}

export function registerAcceptanceProject(project, files, composeEnv, root = ROOT) {
  if (!composeEnv.PACTAGENT_ACCEPTANCE_RESOURCE_JOURNAL) return;
  const path = journalPath(composeEnv, root);
  const entry = validateProject({ project, files,
    env: Object.fromEntries(PUBLIC_COMPOSE_KEYS.filter(key => composeEnv[key] !== undefined)
      .map(key => [key, composeEnv[key]])) }, composeEnv, root);
  const entries = readJournal(path);
  if (entries.length >= MAX_PROJECTS) throw new Error("Too many acceptance projects");
  entries.push(entry);
  const temporary = path + ".tmp";
  writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
  renameSync(temporary, path); // Recorded BEFORE any container/volume creation.
}

function bounded(command, args, seconds, env, run = spawnSync) {
  return run("timeout", ["--signal=TERM", "--kill-after=20s", `${seconds}s`, command, ...args],
    { cwd: ROOT, env, stdio: "inherit", timeout: (seconds + 25) * 1000 });
}

export function cleanupProjects(env, root = ROOT, run = spawnSync) {
  const path = journalPath(env, root);
  if (!existsSync(path)) return; // Checkout/setup/prepare may have failed.
  let failed = false;
  // Validate EVERY record before executing any destructive Docker operation.
  const entries = readJournal(path).map(entry => validateProject(entry, env, root));
  for (const entry of entries) {
    const args = ["compose", ...entry.files.flatMap(file => ["-f", file]), "-p", entry.project,
      "down", "--volumes", "--remove-orphans", "--timeout", "10"];
    const result = bounded("docker", args, 30, { ...env, ...entry.env }, run);
    if (result.status !== 0 || result.error) failed = true;
  }
  if (failed) throw new Error("Acceptance resource cleanup failed");
}

function main() {
  // Never start local Docker through this entry point, even accidentally.
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("This command requires an ephemeral GitHub-hosted Ubuntu runner");
  }
  const env = ciEnvironment(process.env);
  const phase = process.argv[2];
  if (phase === "cleanup") return cleanupProjects(env);
  if (phase === "prepare") {
    if (readdirSync(ROOT).some(name => (name === ".env" || name.startsWith(".env.")) && name !== ".env.example")) {
      throw new Error("Acceptance checkout must not contain application environment files");
    }
    mkdirSync(env.HOME, { recursive: true });
    mkdirSync(resolve(ROOT, ".local/issue-62-ci"), { recursive: true });
    writeFileSync(journalPath(env, ROOT), "[]", { flag: "wx", mode: 0o600 });
    for (const args of [["version"], ["compose", "version"]]) {
      if (bounded("docker", args, 20, env).status !== 0) throw new Error("Docker runner preflight failed");
    }
    return;
  }
  if (!Object.hasOwn(PHASES, phase)) throw new Error("Unknown Issue #62 CI phase");
  const [seconds, ...args] = PHASES[phase];
  const result = bounded("npm", args, seconds, env);
  if (result.status !== 0 || result.error) throw new Error(`Issue #62 ${phase} failed or timed out`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
