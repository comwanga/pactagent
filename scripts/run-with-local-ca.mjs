import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  PROJECT_ROOT,
  childEnvironmentWithCa,
  loadLocalEnvironment,
  resolveLocalCaPath,
} from "./local-env.mjs";
import { runForeground } from "./local-process.mjs";

const [target, ...args] = process.argv.slice(2);
if (!target) {
  console.error("A local child script is required.");
  process.exit(2);
}
const allowMissingCa = args.includes("--allow-missing-ca");
const forwardedArgs = args.filter((value) => value !== "--allow-missing-ca");
const environment = loadLocalEnvironment();
const caPath = resolveLocalCaPath(environment);
if (!existsSync(caPath) && !allowMissingCa) {
  console.error("Local Caddy CA is missing. Run npm run local:up first.");
  process.exit(1);
}
const childEnvironment = existsSync(caPath)
  ? childEnvironmentWithCa(environment, caPath)
  : environment;
const scriptPath = isAbsolute(target) ? target : resolve(PROJECT_ROOT, target);
process.exitCode = await runForeground(process.execPath, [scriptPath, ...forwardedArgs], {
  env: childEnvironment,
});
