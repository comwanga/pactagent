import { spawnSync } from "node:child_process";

/*
 * Railway CLI helpers for Issue #39 deployment tooling.
 *
 * Reads configuration FROM Railway at runtime so operators never copy
 * variable values (especially secrets) into local files or command lines.
 *
 * SECURITY: callers must never print variable values. The doctor and
 * acceptance runners only print variable NAMES and safe public values
 * (public domains, public keys).
 */

export function runRailway(args, options = {}) {
  const result = spawnSync(process.env.RAILWAY_BIN ?? "railway", args, {
    shell: process.platform === "win32",
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`railway ${args[0]} exited with status ${result.status}`);
  }
  return result.stdout;
}

/**
 * Read the full variable map of a service from Railway. Values stay in
 * memory of the calling process only.
 */
export function readRailwayServiceVariables(service) {
  const stdout = runRailway(["variable", "list", "--service", service, "--json"]);
  const parsed = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Unexpected railway variable output for service ${service}`);
  }
  return parsed;
}

export function requireRailwayVariable(variables, name, context) {
  const value = variables[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context}: ${name} is missing on Railway`);
  }
  return value;
}
