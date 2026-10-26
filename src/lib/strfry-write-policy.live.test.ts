import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import type { SignedNostrEvent } from "../domain/nostr";
import { WebSocketNostrRelayAdapter } from "./nostr-relay";
import {
  createLocalNostrEncrypter, PRIVATE_GIFT_WRAP_RETENTION_SECONDS,
  sealPrivateTask, openPrivateTask,
} from "./private-task-transport";

const url = process.env.PACTAGENT_HOSTED_PROTOCOL_URL!;
const secret = (name: string) => Uint8Array.from(Buffer.from(process.env[name]!, "hex"));
const now = () => Math.floor(Date.now() / 1000);
function event(kind: number, key: Uint8Array = secret("PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY"),
  content = "{}", tags: string[][] = [], created_at = now()): SignedNostrEvent {
  return finalizeEvent({ kind, created_at, content, tags: [...tags, ["test", randomUUID()]] }, key) as unknown as SignedNostrEvent;
}
async function connected<T>(action: (relay: WebSocketNostrRelayAdapter) => Promise<T>): Promise<T> {
  const relay = new WebSocketNostrRelayAdapter(url, { defaultTimeoutMs: 15000 });
  await relay.connect();
  try { return await action(relay); } finally { await relay.disconnect(); }
}
function gift(recipient: string, content = "ciphertext", createdAt = now()) {
  return event(1059, generateSecretKey(), content,
    [["p", recipient], ["expiration", String(createdAt + PRIVATE_GIFT_WRAP_RETENTION_SECONDS)]], createdAt);
}

describe("packaged hosted Strfry write policy (signed events through public WSS)", () => {
  it("rejects a valid kind-1 event and unauthorized coordination", async () => {
    await connected(async relay => {
      await expect(relay.publish(event(1, generateSecretKey()))).rejects.toMatchObject({ code: "publish_rejected" });
      for (const kind of [0, 10002, 30360, 30361, 30400, 3921, 7300, 7301]) {
        await expect(relay.publish(event(kind, generateSecretKey()))).rejects.toMatchObject({ code: "publish_rejected" });
      }
    });
  });

  it("accepts enrolled provider, independent requester and authority event types; reads stay public", async () => {
    const requester = secret("PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY");
    const authority = secret("PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY");
    const events = [0, 10002, 30360, 30361, 30400, 3921, 7301].map(kind => event(kind));
    events.push(event(30360, requester), event(3921, requester), event(7300, requester), event(3921, authority));
    await connected(async relay => {
      for (const candidate of events) await relay.publish(candidate);
      await expect(relay.publish(event(30400, requester))).rejects.toMatchObject({ code: "publish_rejected" });
    });
    const root = events.find(e => e.kind === 3921)!;
    await connected(async reader => {
      expect((await reader.queryEvents({ ids: [root.id] })).map(e => e.id)).toContain(root.id);
    });
  });

  it("publishes and decrypts a maximum 1 MiB private document with a maximum prompt", async () => {
    const requester = createLocalNostrEncrypter(process.env.PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY!);
    const provider = createLocalNostrEncrypter(process.env.PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY!);
    const provenance = { agreementId: "relay-policy-maximum-task", agreementRoot: "a".repeat(64),
      authorizedSender: requester.publicKey, recipient: provider.publicKey };
    const payload = { source_document: "\u0000".repeat(1048576), input_media_type: "text/plain" as const,
      private_prompt: "\u0000".repeat(65536) };
    const sealed = await sealPrivateTask(payload, requester, provenance, now());
    await connected(async relay => { await relay.publish(sealed.wrapEvent); });
    await connected(async reader => {
      const stored = await reader.queryEvents({ ids: [sealed.wrapEvent.id] });
      expect(openPrivateTask(stored[0], provider, provenance)).toEqual(payload);
    });
    console.info("RELAY_POLICY_MAX_TASK_BYTES", sealed.measurements.normalizedEventBytes);
  });

  it("rejects missing recipients, missing expiry, oversize events and future timestamps", async () => {
    const provider = getPublicKey(secret("PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY"));
    const giftBaseBytes = Buffer.byteLength(JSON.stringify(gift(provider, "")));
    const oversizedGift = gift(provider, "x".repeat(4 * 1024 * 1024 - giftBaseBytes + 1));
    expect(Buffer.byteLength(JSON.stringify(oversizedGift))).toBe(4 * 1024 * 1024 + 1);
    // Each semantic rejection must come from the relay on a fresh connection.
    // A frame-limit close must not make subsequent cases pass as not_connected.
    for (const candidate of [event(1059, generateSecretKey()),
      event(1059, generateSecretKey(), "ciphertext", [["p", provider]]), oversizedGift,
      event(3921, undefined, "x".repeat(65536)),
      event(3921, undefined, "{}", [], now() + 120)]) {
      await connected(async relay => {
        await expect(relay.publish(candidate)).rejects.toMatchObject({ code: "publish_rejected" });
      });
    }
  });

  it("enforces recipient quota across fresh authors and connections, then resets the window", async () => {
    const recipient = getPublicKey(secret("PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY"));
    for (let i = 0; i < 12; i++) {
      await connected(async relay => { await relay.publish(gift(recipient)); });
    }
    await connected(async relay => {
      await expect(relay.publish(gift(recipient))).rejects.toMatchObject({ code: "publish_rejected" });
    });
    await new Promise(resolve => setTimeout(resolve, 61000));
    await connected(async relay => { await relay.publish(gift(recipient)); });
  });

  it("native expiration removes a gift wrap without removing agreement evidence", async () => {
    const provider = getPublicKey(secret("PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY"));
    const expiring = gift(provider, "expired-fixture", now() - PRIVATE_GIFT_WRAP_RETENTION_SECONDS + 20);
    const evidence = event(3921);
    await connected(async relay => {
      await relay.publish(expiring);
      // Native cron intentionally preserves the highest local event ID.
      await relay.publish(evidence);
    });
    await connected(async reader => {
      expect(await reader.queryEvents({ ids: [expiring.id] })).toHaveLength(1);
    });
    await expect.poll(() => connected(reader => reader.queryEvents({ ids: [expiring.id] })),
      { timeout: 45000, interval: 1000 }).toHaveLength(0);
    await connected(async reader => {
      expect(await reader.queryEvents({ ids: [evidence.id] })).toHaveLength(1);
    });
  });

  it("accepts only the enrolled exact pre-upgrade prepared wrap without changing its ID", async () => {
    const legacy = JSON.parse(process.env.PACTAGENT_RELAY_LEGACY_TEST_EVENT!) as SignedNostrEvent;
    await connected(async relay => { await relay.publish(legacy); });
    await connected(async reader => {
      expect((await reader.queryEvents({ ids: [legacy.id] }))[0]).toEqual(legacy);
    });
  });

  it("fails closed on a killed plugin and preserves recipient quota after automatic restart", async () => {
    const project = process.env.PACTAGENT_RELAY_TEST_COMPOSE_PROJECT ?? "";
    if (process.env.PACTAGENT_HOSTED_ACCEPTANCE !== "true" || new URL(url).hostname !== "localhost" ||
      !/^pactagent-(?:62-ci-\d+-\d+-)?hosted-[a-z0-9]+-[0-9a-f]{8}$/.test(project)) {
      throw new Error("Plugin fault injection requires the disposable loopback acceptance project");
    }
    const recipients = JSON.parse(process.env.PACTAGENT_RELAY_RATE_TEST_RECIPIENTS!) as string[];
    const recipient = recipients[10];
    await connected(async relay => {
      for (let i = 0; i < 12; i++) await relay.publish(gift(recipient));
    });
    // Only the plugin process in THIS disposable container can match argv[1].
    // Kill between acknowledged writes, after its SQLite transaction committed.
    execFileSync("docker", ["compose", "-f", resolve("compose.hosted.yml"),
      "-f", resolve("local/compose.hosted-acceptance.yml"), "-p", project,
      "exec", "-T", "strfry", "python3", "-c", `
import os,signal
matches=[]
for name in os.listdir('/proc'):
    if not name.isdigit(): continue
    try:
        with open('/proc/'+name+'/cmdline','rb') as handle: args=handle.read().split(b'\\0')
        if len(args)>1 and args[1]==b'/app/strfry-write-policy.py': matches.append(int(name))
    except (FileNotFoundError,PermissionError): pass
assert len(matches)==1, 'Expected exactly one disposable policy process'
os.kill(matches[0],signal.SIGKILL)
`], { env: process.env, timeout: 10000, stdio: "pipe" });
    await connected(async relay => {
      await expect(relay.publish(event(0))).rejects.toMatchObject({ code: "publish_rejected" });
    });
    await connected(async relay => {
      await relay.publish(event(0)); // Strfry restarts the policy, without opening writes.
      await expect(relay.publish(event(1, generateSecretKey()))).rejects.toMatchObject({ code: "publish_rejected" });
      await expect(relay.publish(gift(recipient))).rejects.toMatchObject({ code: "publish_rejected" });
    });
  });

  it("enforces the global gift quota across enrolled recipients and fresh outer signing keys", async () => {
    const recipients = JSON.parse(process.env.PACTAGENT_RELAY_RATE_TEST_RECIPIENTS!) as string[];
    await new Promise(resolve => setTimeout(resolve, 61000));
    await connected(async relay => {
      for (const recipient of recipients.slice(0, 10)) {
        for (let i = 0; i < 12; i++) await relay.publish(gift(recipient));
      }
      await expect(relay.publish(gift(recipients[10]))).rejects.toMatchObject({ code: "publish_rejected" });
    });
  });
});
