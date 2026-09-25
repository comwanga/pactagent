#!/usr/bin/env node

/*
 * Issue #33 runtime bootstrap CLI.
 *
 * The long-lived runtime is wired lazily from environment on first use. This
 * script drives that bootstrap over the HTTP surface and reports only safe
 * readiness information. It requires a running `npm run runtime:start` server
 * (or an equivalent `next start` host).
 */

import { loadLocalEnvironment, runtimeBaseUrl } from "./local-env.mjs";

const environment = loadLocalEnvironment();
const token = environment.PACTAGENT_RUNTIME_API_TOKEN;
if (!token) {
  console.error("Missing PACTAGENT_RUNTIME_API_TOKEN.");
  process.exit(1);
}

const base = runtimeBaseUrl(environment);

const response = await fetch(`${base}/api/runtime/bootstrap`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});

let body;
try {
  body = await response.json();
} catch {
  body = null;
}

console.log(JSON.stringify(body ?? { error: "unexpected response" }, null, 2));
process.exit(response.ok ? 0 : 1);
