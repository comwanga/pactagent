import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildFixture, buildRuntimeConfig, ROOT_TIME, sharedStores, startInput } from "./pactagent-runtime-test-fixture";
import { createPactAgentRuntime } from "./pactagent-runtime";
import { sealPrivateTask } from "./private-task-transport";

it("admits every signed event from a settled independent-requester transaction and its maximum private task", async () => {
  const fixture = buildFixture();
  const built = buildRuntimeConfig(fixture, sharedStores());
  const runtime = createPactAgentRuntime(built.config);
  const directory = mkdtempSync(join(tmpdir(), "pactagent-policy-transaction-"));
  try {
    await runtime.start();
    const result = await runtime.startTransaction(startInput());
    expect(result.report.finalOutcome).toBe("settled");
    const maximum = await sealPrivateTask({ source_document: "\u0000".repeat(1048576),
      input_media_type: "text/plain", private_prompt: "\u0000".repeat(65536) },
    fixture.identities.requesterEncrypter, { agreementId: "maximum-policy-task",
      agreementRoot: "a".repeat(64), authorizedSender: fixture.identities.requesterSigner.publicKey,
      recipient: fixture.identities.providerSigner.publicKey }, ROOT_TIME);
    const events = [...built.relay.events, maximum.wrapEvent];
    const validation = spawnSync(process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
      ["-B", "-c", `
import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("policy","deploy/strfry-write-policy.py")
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
p=module.Policy(os.environ,initialize=True)
try:
    events=json.load(sys.stdin)
    for event in events:
        p.evaluate({"type":"new","event":event,"receivedAt":${ROOT_TIME},"sourceType":"IP4","sourceInfo":"proxy"},${ROOT_TIME})
    print(len(events))
finally:
    p.db.close()
`], { encoding: "utf8", input: JSON.stringify(events), env: { ...process.env,
        PACTAGENT_RELAY_PROVIDER_AUTHORS: fixture.identities.providerSigner.publicKey,
        PACTAGENT_RELAY_REQUESTER_AUTHORS: fixture.identities.requesterSigner.publicKey,
        PACTAGENT_RELAY_AUTHORITY_AUTHORS: fixture.identities.escrowAuthoritySigner.publicKey,
        PACTAGENT_RELAY_POLICY_STATE: join(directory, "policy.sqlite"),
        PACTAGENT_RELAY_LEGACY_GIFT_IDS: "",
      } });
    expect(validation.status, validation.stderr).toBe(0);
    expect(Number(validation.stdout.trim())).toBe(events.length);
    expect(new Set(built.relay.events.map(e => e.kind))).toEqual(new Set([30360, 30361, 30400, 3921, 1059]));
    expect(maximum.measurements.normalizedEventBytes).toBe(3495793);
  } finally {
    await runtime.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
