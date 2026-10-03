import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

const repositoryRoot = process.cwd();
const localRoot = resolve(repositoryRoot, ".local");
const stateDirectory = resolve(localRoot, "requester-e2e-state");
const relativeStateDirectory = relative(localRoot, stateDirectory);
if (relativeStateDirectory.startsWith("..") || isAbsolute(relativeStateDirectory)) {
  throw new Error("Refusing to clear an E2E state directory outside .local");
}
rmSync(stateDirectory, { recursive: true, force: true });

const nextCli = resolve(repositoryRoot, "node_modules", "next", "dist", "bin", "next");
const build = spawnSync(process.execPath, [nextCli, "build"], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);
