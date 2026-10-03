import { existsSync } from "node:fs";

import {
  PROJECT_ROOT,
  childEnvironmentWithCa,
  loadLocalEnvironment,
  preflightRuntimeStartLocal,
  resolveLocalCaPath,
} from "./local-env.mjs";
import { nextBinary, runChecked, runForeground } from "./local-process.mjs";

const environment = loadLocalEnvironment();
const preflight = preflightRuntimeStartLocal(environment);
if (preflight.action === "exit") {
  console.error(preflight.detail);
  process.exit(preflight.code);
}

const caPath = resolveLocalCaPath(environment);
if (!existsSync(caPath)) {
  console.error("Local Caddy CA is missing. Run npm run local:up first.");
  process.exit(1);
}
const childEnvironment = childEnvironmentWithCa(environment, caPath);

if (!existsSync(`${PROJECT_ROOT}/.next/BUILD_ID`)) {
  console.log("No production build found; building PactAgent before local startup.");
  await runChecked(process.execPath, [nextBinary, "build"], { env: childEnvironment });
}

console.log(`Starting PactAgent with NODE_EXTRA_CA_CERTS=${caPath}`);
process.exitCode = await runForeground(process.execPath, [nextBinary, "start"], {
  env: childEnvironment,
});
