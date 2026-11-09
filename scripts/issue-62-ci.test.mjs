import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ciEnvironment, cleanupProjects, registerAcceptanceProject } from "./issue-62-ci.mjs";

let root, env, journal;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pactagent-62-ci-test-"));
  env = ciEnvironment({ PATH: "test-path", RUNNER_TEMP: root, GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: "2" }, root);
  journal = env.PACTAGENT_ACCEPTANCE_RESOURCE_JOURNAL;
  mkdirSync(resolve(root, ".local/issue-62-ci"), { recursive: true });
  writeFileSync(journal, "[]");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const name = suffix => `pactagent-62-ci-1234-2-hosted-${suffix}`;
function record(suffix, extra = {}) {
  registerAcceptanceProject(name(suffix),
    [resolve(root, "compose.hosted.yml"), resolve(root, "local/compose.hosted-acceptance.yml")],
    { ...env, PACTAGENT_HOSTED_WSS_HOSTNAME: "localhost", ...extra }, root);
}

describe("Issue #62 runner isolation and cleanup", () => {
  it("drops deployment credentials, remote endpoints, Docker context, and npm authentication", () => {
    const source = { PATH: "path", RUNNER_TEMP: root, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1",
      GITHUB_TOKEN: "private", RAILWAY_TOKEN: "private", AWS_SECRET_ACCESS_KEY: "private",
      SSH_AUTH_SOCK: "private", NODE_AUTH_TOKEN: "private", NPM_TOKEN: "private",
      DOCKER_HOST: "tcp://production:2376", DOCKER_CONTEXT: "production",
      PACTAGENT_LIVE_RELAY_URL: "wss://production", PACTAGENT_CASHU_TEST_MINT_URL: "https://production",
      PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY: "private", PACTAGENT_REQUESTER_DECISION_MODE: "model" };
    const isolated = ciEnvironment(source, root);
    expect(JSON.stringify(isolated)).not.toMatch(/private|production/);
    expect(isolated.PACTAGENT_ECONOMIC_MODE).toBe("demo");
    expect(isolated.PACTAGENT_REQUESTER_DECISION_MODE).toBe("deterministic");
    expect(isolated.HOME).toBe(resolve(root, "pactagent-62-home"));
  });

  it("rejects missing or untrusted runner identifiers", () => {
    for (const id of ["", "../production", "1;docker volume prune", "${{ secrets.TOKEN }}"]) {
      expect(() => ciEnvironment({ RUNNER_TEMP: root, GITHUB_RUN_ID: id, GITHUB_RUN_ATTEMPT: "1" }, root)).toThrow();
    }
  });

  it("journals public Compose inputs without application keys and cleans exactly the recorded project", () => {
    record("abc", { PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY: "PRIVATE-MARKER", RAILWAY_TOKEN: "PRIVATE-MARKER" });
    expect(readFileSync(journal, "utf8")).not.toContain("PRIVATE-MARKER");
    const calls = [];
    cleanupProjects(env, root, (...args) => { calls.push(args); return { status: 0 }; });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("timeout");
    expect(calls[0][1]).toContain(name("abc"));
    expect(calls[0][1]).toContain("--volumes");
    expect(calls[0][1]).not.toContain("prune");
    expect(calls[0][2].env.PACTAGENT_HOSTED_WSS_HOSTNAME).toBe("localhost");
  });

  it("supports stock-baseline project cleanup without accepting other Compose files", () => {
    const project = "pactagent-62-ci-1234-2-baseline-abc";
    registerAcceptanceProject(project, [resolve(root, ".local", project, "compose.json")], env, root);
    expect(() => registerAcceptanceProject(name("bad"), [resolve(root, "compose.local.yml")], env, root)).toThrow();
    const calls = [];
    cleanupProjects(env, root, (...args) => { calls.push(args); return { status: 0 }; });
    expect(calls[0][1]).toContain(project);
  });

  it("validates the complete journal before any deletion, including cross-run namespace attacks", () => {
    record("good");
    const original = JSON.parse(readFileSync(journal, "utf8"));
    for (const project of ["pactagent-hosted", "pactagent-62-ci-1234-1-hosted-old", "pactagent-62-ci-1234-2-extra-hosted-abc"]) {
      writeFileSync(journal, JSON.stringify([...original, { ...original[0], project }]));
      const calls = [];
      expect(() => cleanupProjects(env, root, (...args) => { calls.push(args); return { status: 0 }; })).toThrow();
      expect(calls).toHaveLength(0);
    }
  });

  it("attempts every owned project after one cleanup failure and fails the job", () => {
    record("first"); record("second");
    const calls = [];
    expect(() => cleanupProjects(env, root, (...args) => { calls.push(args); return { status: calls.length === 1 ? 1 : 0 }; })).toThrow(/cleanup failed/);
    expect(calls).toHaveLength(2);
  });

  it("bounds the journal and refuses arbitrary journal paths", () => {
    record("a"); record("b"); record("c");
    expect(() => record("d")).toThrow(/Too many/);
    expect(() => cleanupProjects({ ...env, PACTAGENT_ACCEPTANCE_RESOURCE_JOURNAL: resolve(root, "foreign.json") }, root)).toThrow();
    writeFileSync(journal, "x".repeat(65537));
    expect(() => cleanupProjects(env, root, () => { throw new Error("Must not invoke Docker"); })).toThrow(/exceeded bound/);
  });

  it("tolerates cleanup before setup has created a journal", () => {
    rmSync(journal);
    cleanupProjects(env, root, () => { throw new Error("Must not invoke Docker"); });
  });

  it("refuses the Docker-running entry point outside a GitHub-hosted Linux runner", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./issue-62-ci.mjs", import.meta.url)), "prepare"],
      { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "false" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires an ephemeral GitHub-hosted Ubuntu runner");
  });
});

it("runs on PRs to main without elevated credentials and always schedules bounded cleanup", () => {
  const workflow = yaml.load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  expect(workflow.on.pull_request.branches).toContain("main");
  expect(workflow.on.pull_request.paths).toBeUndefined();
  expect(workflow.on.pull_request_target).toBeUndefined();
  const job = workflow.jobs["relay-policy"];
  expect(job["runs-on"]).toBe("ubuntu-24.04");
  expect(job.permissions).toEqual({ contents: "read" });
  expect(job.environment).toBeUndefined();
  expect(job.steps[0].with["persist-credentials"]).toBe(false);
  expect(job.steps.find(step => step.uses?.startsWith("actions/setup-node@")).with["package-manager-cache"]).toBe(false);
  for (const step of job.steps.filter(step => step.uses)) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  const cleanup = job.steps.at(-1);
  expect(cleanup.if).toBe("${{ always() }}");
  expect(cleanup.run).toBe("node scripts/issue-62-ci.mjs cleanup");
  expect(cleanup["timeout-minutes"]).toBe(3);
  expect(JSON.stringify(job)).not.toMatch(/secrets\.|secrets:|id-token|railway |deploy /);
});
