import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
  ["-B", fileURLToPath(new URL("../deploy/test_strfry_write_policy.py", import.meta.url))],
  { stdio: "inherit" });
if (result.error) console.error("Python 3 is required for relay policy tests");
process.exitCode = result.status ?? 1;
