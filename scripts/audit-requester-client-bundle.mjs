import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const staticDirectory = join(process.cwd(), ".next", "static");

if (!existsSync(staticDirectory)) {
  throw new Error("Build the production client bundle before auditing it.");
}

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });
}

function parseLocalEnvironment() {
  if (!existsSync(".env")) return new Map();

  return new Map(
    readFileSync(".env", "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator);
        let value = line.slice(separator + 1).trim();
        if (
          value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
        ) {
          value = value.slice(1, -1);
        }
        return [key, value];
      }),
  );
}

const files = collectFiles(staticDirectory).map((path) => ({
  path,
  content: readFileSync(path),
}));
const environment = parseLocalEnvironment();
const failures = [];

for (const key of [
  "PACTAGENT_RUNTIME_API_TOKEN",
  "PACTAGENT_LIVE_FUNDING_REFERENCE",
  "PACTAGENT_LIVE_FUNDING_TOKEN",
  "PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY",
  "PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY",
  "PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY",
  "PACTAGENT_LIVE_NORMAL_SPEND_KEY",
  "PACTAGENT_LIVE_REFUND_SPEND_KEY",
  "PACTAGENT_REQUESTER_MODEL_API_KEY",
]) {
  const value = environment.get(key);
  if (!value || value.length < 4) {
    console.log(`${key}: no configured value to scan`);
    continue;
  }

  const matches = files.filter(({ content }) => content.includes(value));
  console.log(`${key}: ${matches.length === 0 ? "no value match" : "VALUE MATCH"}`);
  if (matches.length > 0) failures.push(key);
}

for (const sentinel of [
  "E2E-RUNTIME-TOKEN-SERVER-ONLY",
  "E2E-FUNDING-SERVER-ONLY",
  "PRIVATE-DOCUMENT-E2E-SENTINEL",
  "PRIVATE-PROMPT-E2E-SENTINEL",
  "PRIVATE-SUMMARY-FOR-",
  "LIVE-ACCEPTANCE-ALPHA",
  "LIVE-PROMPT-ALPHA",
]) {
  const matches = files.filter(({ content }) => content.includes(sentinel));
  console.log(`${sentinel}: ${matches.length === 0 ? "absent" : "MATCH"}`);
  if (matches.length > 0) failures.push(sentinel);
}

console.log("requester session secret: runtime-generated opaque value; no build-time value exists to bundle");

for (const identifier of [
  "PACTAGENT_RUNTIME_API_TOKEN",
  "fundingReference",
  "privateDocument",
  "privatePrompt",
]) {
  const matches = files.filter(({ content }) => content.includes(identifier));
  console.log(`${identifier} identifier: ${matches.length} client file(s)`);
}

if (failures.length > 0) {
  throw new Error(`Client bundle privacy audit failed for ${failures.join(", ")}.`);
}
