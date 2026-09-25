import { existsSync } from "node:fs";

import {
  PROJECT_ROOT,
  childEnvironmentWithCa,
  loadLocalEnvironment,
  missingRequiredVariables,
  resolveLocalCaPath,
} from "./local-env.mjs";
import { nextBinary, runChecked, runForeground } from "./local-process.mjs";

const environment = loadLocalEnvironment();
const caPath = resolveLocalCaPath(environment);
const missing = missingRequiredVariables(environment);
if (missing.length > 0) {
  console.error(`Missing required local environment variable names: ${missing.join(", ")}`);
  process.exit(1);
}
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
