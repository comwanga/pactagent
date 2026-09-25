import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

import { expect, it } from "vitest";

import { DOCUMENT_SUMMARY_PROFILE_ID } from "../domain/pact-service-agreement";
import { createNostrIdentity } from "../domain/nostr";
import { createLiveRequesterDecisionFromEnv } from "./pactagent-runtime.live";
import type { SafeRequesterDecisionInput } from "./requester-decision";

it("completes one bounded non-economic structured requester recommendation", async () => {
  const environment: Record<string, string | undefined> = { ...process.env };
  const environmentPath = resolve(process.cwd(), ".env");
  if (existsSync(environmentPath)) {
    for (const [name, value] of Object.entries(parseEnv(readFileSync(environmentPath, "utf8")))) {
      if (environment[name] === undefined) environment[name] = value;
    }
  }
  const selected = createLiveRequesterDecisionFromEnv(environment);
  expect(selected.source, "PACTAGENT_REQUESTER_DECISION_MODE must be model").toBe("model");

  const providerPublicKey = createNostrIdentity(
    "22".repeat(32),
    ["wss://synthetic.invalid"],
  ).publicKey;
  const input: SafeRequesterDecisionInput = Object.freeze({
    instruction: "Evaluate the single synthetic verified offer against a 500-sat maximum budget.",
    capabilityProfile: DOCUMENT_SUMMARY_PROFILE_ID,
    maximumBudgetSats: "500",
    candidates: Object.freeze([Object.freeze({
      providerPublicKey,
      providerDefinitionReference: `30360:${providerPublicKey}:synthetic-provider`,
      offerReference: `30400:${providerPublicKey}:synthetic-350-sat-offer`,
      escrowDescriptorReference: `30361:${providerPublicKey}:synthetic-cashu-escrow`,
      amountSats: "350",
      settlementNetwork: "cashu" as const,
      maximumExecutionSeconds: 120,
    })]),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const output = await selected.model.recommend(input, { signal: controller.signal });
    expect(output).toBeTypeOf("object");
    expect(output).not.toBeNull();
    const record = output as Record<string, unknown>;
    expect(["recommend", "decline"]).toContain(record.action);
    if (record.action === "recommend") {
      expect(record).toMatchObject({
        providerPublicKey,
        providerDefinitionReference: input.candidates[0].providerDefinitionReference,
        offerReference: input.candidates[0].offerReference,
        escrowDescriptorReference: input.candidates[0].escrowDescriptorReference,
        proposedAmountSats: "350",
      });
    }
  } finally {
    clearTimeout(timeout);
  }
});
