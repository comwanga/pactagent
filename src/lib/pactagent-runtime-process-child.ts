import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

import { sats } from "../domain/money";
import { PACT_SERVICE_AGREEMENT_ROOT_TYPE } from "../domain/pact-service-agreement";
import type { SignedNostrEvent } from "../domain/nostr";
import { POST as postTransaction } from "../app/api/transactions/route";
import { GET as getTransaction } from "../app/api/transactions/[id]/route";
import { GET as getTransactionReport } from "../app/api/transactions/[id]/report/route";
import { GET as getTransactionResult } from "../app/api/transactions/[id]/result/route";
import { POST as resumeTransaction } from "../app/api/transactions/[id]/resume/route";
import { POST as reconcileTransaction } from "../app/api/transactions/[id]/reconcile/route";
import {
  createSqlitePactCashuEscrowSettlementStore,
} from "./cashu-escrow-settlement";
import {
  CashuPrivateBackendError,
  createCashuTestMintAdapterWithBackend,
  createPrivateCashuFunding,
  createSqliteCashuPrivateStore,
  type CashuMintCapabilitySnapshot,
  type CashuMintPrivateBackend,
  type CashuPrivatePreparedSwap,
  type CashuPrivateProofState,
  type CashuPrivateSwapResult,
  type CashuTestMintPort,
  type PrepareLockedValueInput,
  type SpendLockedValueInput,
} from "./cashu-test-mint";
import { fakeProof, fakeSum } from "./cashu-test-fixture";
import type { NostrFilter, NostrRelayAdapter } from "./nostr-relay";
import {
  buildFixture,
  filterMatches,
  MINT_URL,
  ROOT_TIME,
} from "./pactagent-runtime-test-fixture";
import { createPactAgentRuntime, type PactAgentRuntimeConfig } from "./pactagent-runtime";
import { DeterministicPactAgentClock } from "./pactagent-workflow";

type Checkpoint = "none" | "after_root" | "after_funding_success" | "after_ambiguous";
type InspectionMode = "unspent" | "spent" | "pending" | "mixed";
type SubmitMode = "success" | "ambiguous_lock" | "ambiguous_spend";

interface RelayState {
  events: SignedNostrEvent[];
  connectCalls: number;
  disconnectCalls: number;
}

interface BackendState {
  prepareLockCalls: number;
  prepareSpendCalls: number;
  submitLockCalls: number;
  submitSpendCalls: number;
  inspectCalls: number;
  restoreCalls: number;
  acceptedAmbiguousLock: boolean;
  acceptedAmbiguousSpend: boolean;
  submitMode: SubmitMode;
  inspectionMode: InspectionMode;
  callLog: string[];
}

interface LifecycleState {
  storeCloseCalls: number;
}

const stateDirectory = requiredEnvironment("PACT_PROCESS_STATE_DIRECTORY");
const action = requiredEnvironment("PACT_PROCESS_ACTION");
const checkpoint = (process.env.PACT_PROCESS_CHECKPOINT ?? "none") as Checkpoint;
const idempotencyKey = process.env.PACT_PROCESS_IDEMPOTENCY_KEY ?? "process-idempotency-0001";
const relayPath = join(stateDirectory, "relay.json");
const backendPath = join(stateDirectory, "backend.json");
const lifecyclePath = join(stateDirectory, "lifecycle.json");

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function emit(type: string, value: Record<string, unknown> = {}): void {
  process.stdout.write(`PACT_PROCESS:${JSON.stringify(
    { type, ...value },
    (_key, entry: unknown) => typeof entry === "bigint" ? entry.toString() : entry,
  )}\n`);
}

async function pauseAt(name: Exclude<Checkpoint, "none">): Promise<never> {
  emit("checkpoint", { name });
  return new Promise<never>(() => undefined);
}

class DurableRelay implements NostrRelayAdapter {
  readonly url = "wss://relay.example";

  constructor(referenceEvents: readonly SignedNostrEvent[]) {
    const state = this.read();
    for (const event of referenceEvents) {
      if (!state.events.some((candidate) => candidate.id === event.id)) state.events.push(event);
    }
    this.write(state);
  }

  private read(): RelayState {
    return readJson<RelayState>(relayPath, { events: [], connectCalls: 0, disconnectCalls: 0 });
  }

  private write(state: RelayState): void {
    writeJson(relayPath, state);
  }

  async connect(): Promise<void> {
    const state = this.read();
    state.connectCalls += 1;
    this.write(state);
  }

  async disconnect(): Promise<void> {
    const state = this.read();
    state.disconnectCalls += 1;
    this.write(state);
  }

  async publish(event: SignedNostrEvent): Promise<void> {
    const state = this.read();
    if (!state.events.some((candidate) => candidate.id === event.id)) state.events.push(event);
    this.write(state);
    if (
      checkpoint === "after_root" &&
      event.tags.some((tag) => tag[0] === "t" && tag[1] === PACT_SERVICE_AGREEMENT_ROOT_TYPE)
    ) {
      await pauseAt("after_root");
    }
  }

  async queryEvents(filter: NostrFilter): Promise<SignedNostrEvent[]> {
    return this.read().events
      .filter((event) => filterMatches(event, filter))
      .sort((left, right) => right.created_at - left.created_at);
  }
}

function initialBackendState(): BackendState {
  return {
    prepareLockCalls: 0,
    prepareSpendCalls: 0,
    submitLockCalls: 0,
    submitSpendCalls: 0,
    inspectCalls: 0,
    restoreCalls: 0,
    acceptedAmbiguousLock: false,
    acceptedAmbiguousSpend: false,
    submitMode:
      process.env.PACT_PROCESS_SUBMIT_MODE === "ambiguous_spend"
        ? "ambiguous_spend"
        : process.env.PACT_PROCESS_SUBMIT_MODE === "ambiguous" ||
            process.env.PACT_PROCESS_SUBMIT_MODE === "ambiguous_lock"
          ? "ambiguous_lock"
          : "success",
    inspectionMode: "unspent",
    callLog: [],
  };
}

class DurableCashuBackend implements CashuMintPrivateBackend {
  private read(): BackendState {
    const state = readJson<BackendState>(backendPath, initialBackendState());
    const requestedMode = process.env.PACT_PROCESS_INSPECTION_MODE as InspectionMode | undefined;
    if (requestedMode) state.inspectionMode = requestedMode;
    return state;
  }

  private write(state: BackendState): void {
    writeJson(backendPath, state);
  }

  async inspectCapabilities(): Promise<CashuMintCapabilitySnapshot> {
    return {
      mintUrl: MINT_URL,
      nuts: { 7: true, 9: true, 10: true, 11: true },
      keysets: [{ id: "00aabb", unit: "sat", active: true, inputFeePpk: 1, hasKeys: true }],
    };
  }

  async prepareLock(input: Parameters<CashuMintPrivateBackend["prepareLock"]>[0]): Promise<CashuPrivatePreparedSwap> {
    const state = this.read();
    state.prepareLockCalls += 1;
    state.callLog.push("prepare:lock");
    this.write(state);
    return {
      kind: "lock",
      inputProofs: input.proofs,
      requestedAmountSats: input.amountSats,
      exposureAmountSats: input.amountSats + 1n,
      opaque: Object.freeze({ privateBlindingMaterial: "PROCESS-PRIVATE-BLINDING" }),
    };
  }

  async prepareSpend(input: Parameters<CashuMintPrivateBackend["prepareSpend"]>[0]): Promise<CashuPrivatePreparedSwap> {
    const state = this.read();
    state.prepareSpendCalls += 1;
    state.callLog.push("prepare:spend");
    this.write(state);
    return {
      kind: "spend",
      inputProofs: input.proofs,
      requestedAmountSats: input.amountSats,
      exposureAmountSats: input.amountSats,
      opaque: Object.freeze({
        privateBlindingMaterial: "PROCESS-PRIVATE-SPEND-BLINDING",
        spendingKeyHex: input.spendingKeyHex,
      }),
    };
  }

  private result(prepared: CashuPrivatePreparedSwap): CashuPrivateSwapResult {
    const outputAmount = prepared.kind === "lock"
      ? prepared.requestedAmountSats + 1n
      : prepared.requestedAmountSats;
    const changeAmount = fakeSum(prepared.inputProofs) - outputAmount - 1n;
    const sendProofs = prepared.kind === "lock"
      ? [
          fakeProof(200n, "process-lock-send-a", "00aabb"),
          fakeProof(outputAmount - 200n, "process-lock-send-b", "00aabb"),
        ]
      : [fakeProof(outputAmount, "process-spend-send", "00aabb")];
    return {
      sendProofs,
      keepProofs: changeAmount > 0n
        ? [fakeProof(changeAmount, `process-${prepared.kind}-change`, "00aabb")]
        : [],
    };
  }

  async submit(prepared: CashuPrivatePreparedSwap): Promise<CashuPrivateSwapResult> {
    const state = this.read();
    if (prepared.kind === "lock") state.submitLockCalls += 1;
    else state.submitSpendCalls += 1;
    state.callLog.push(`submit:${prepared.kind}`);
    const ambiguous =
      (prepared.kind === "lock" &&
        state.submitMode === "ambiguous_lock" &&
        !state.acceptedAmbiguousLock) ||
      (prepared.kind === "spend" &&
        state.submitMode === "ambiguous_spend" &&
        !state.acceptedAmbiguousSpend);
    if (ambiguous && prepared.kind === "lock") state.acceptedAmbiguousLock = true;
    if (ambiguous && prepared.kind === "spend") state.acceptedAmbiguousSpend = true;
    this.write(state);
    if (ambiguous) {
      throw new CashuPrivateBackendError("timeout", "submitted_unknown");
    }
    return this.result(prepared);
  }

  async inspectProofStates(proofs: CashuPrivatePreparedSwap["inputProofs"]): Promise<readonly CashuPrivateProofState[]> {
    const state = this.read();
    state.inspectCalls += 1;
    state.callLog.push("inspect");
    this.write(state);
    const inspectionMode = state.inspectionMode;
    if (inspectionMode === "mixed") {
      return proofs.map((_, index) => ({ state: index === 0 ? "spent" : "unspent" }));
    }
    return proofs.map(() => ({ state: inspectionMode }));
  }

  async restore(prepared: CashuPrivatePreparedSwap): Promise<CashuPrivateSwapResult | undefined> {
    const state = this.read();
    state.restoreCalls += 1;
    state.callLog.push("restore");
    this.write(state);
    return state.inspectionMode === "spent" ? this.result(prepared) : undefined;
  }
}

function processFunding() {
  return createPrivateCashuFunding({
    mintUrl: MINT_URL,
    unit: "sat",
    proofs: [
      fakeProof(200n, "process-funding-a", "00aabb"),
      fakeProof(200n, "process-funding-b", "00aabb"),
    ],
  });
}

async function buildRuntimeConfig(): Promise<{
  config: PactAgentRuntimeConfig;
  closeStores: () => void;
}> {
  const fixture = buildFixture();
  const relay = new DurableRelay(fixture.referenceEvents);
  const privateStore = createSqliteCashuPrivateStore(join(stateDirectory, "cashu-private.sqlite"));
  const settlementStore = createSqlitePactCashuEscrowSettlementStore(
    join(stateDirectory, "escrow-settlement.sqlite"),
  );
  const adapter = createCashuTestMintAdapterWithBackend({
    configuration: {
      testMintUrl: MINT_URL,
      unit: "sat",
      maximumExposureSats: sats(500n),
    },
    backend: new DurableCashuBackend(),
    privateStore,
  });
  const cashu: CashuTestMintPort = {
    inspectCapabilities: () => adapter.inspectCapabilities(),
    inspectProofState: (handle) => adapter.inspectProofState(handle),
    async prepareLockedValue(input: PrepareLockedValueInput) {
      const result = await adapter.prepareLockedValue(input);
      if (checkpoint === "after_funding_success" && result.status === "succeeded") {
        await pauseAt("after_funding_success");
      }
      if (
        checkpoint === "after_ambiguous" &&
        result.status === "submitted_unknown" &&
        result.outcome === "reconciliation_required"
      ) {
        await pauseAt("after_ambiguous");
      }
      return result;
    },
    spendLockedValue: (input: SpendLockedValueInput) => adapter.spendLockedValue(input),
  };
  const clock = new DeterministicPactAgentClock(ROOT_TIME);
  return {
    config: {
      identities: fixture.identities,
      references: fixture.references,
      selectedReferences: fixture.selectedReferences,
      privateStore,
      resolveFunding: async (reference) => {
        if (
          reference !== "funding-reference-process" &&
          reference !== "PROCESS-FUNDING-REFERENCE-MARKER"
        ) {
          throw new Error("Unknown funding reference");
        }
        return processFunding();
      },
      dependencies: {
        relay,
        clock,
        requesterPolicy: fixture.requesterPolicy,
        decisionModel: fixture.decisionModel,
        decisionBounds: fixture.decisionBounds,
        cashu,
        privateDelivery: {
          async deliver(input) {
            return {
              status: "delivered" as const,
              deliveryId: input.deliveryId,
              beneficiary: input.expectedBeneficiary,
            };
          },
        },
        settlementStore,
        mintUrl: fixture.mintUrl,
        normalSpendKey: fixture.normalSpendKey,
        refundSpendKey: fixture.refundSpendKey,
      },
    },
    closeStores() {
      const lifecycle = readJson<LifecycleState>(lifecyclePath, { storeCloseCalls: 0 });
      lifecycle.storeCloseCalls += 1;
      writeJson(lifecyclePath, lifecycle);
      settlementStore.close();
      privateStore.close();
    },
  };
}

async function run(): Promise<void> {
  const { config, closeStores } = await buildRuntimeConfig();
  if (action === "signal" || action === "http") {
    const singleton = await import("./pactagent-runtime-singleton");
    singleton.registerPactAgentRuntimeShutdownHandlers();
    singleton.configurePactAgentRuntime(config, closeStores);
    await singleton.getPactAgentRuntime();
    if (action === "http") {
      const server = createServer((request, response) => {
        void dispatchHttp(request, response).catch(() => {
          response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "Internal error", code: "internal_error" }));
        });
      });
      await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("HTTP address unavailable");
      process.on("message", (message) => {
        if (message !== "shutdown-http") return;
        void singleton.shutdownPactAgentRuntime().finally(() => {
          server.close(() => process.exit(0));
        });
      });
      emit("ready", { port: address.port });
      return;
    }
    process.on("message", (message) => {
      if (message === "emit-sigterm") process.emit("SIGTERM", "SIGTERM");
    });
    emit("ready");
    setInterval(() => undefined, 60_000);
    return;
  }

  const runtime = createPactAgentRuntime(config);
  await runtime.start();
  try {
    if (action === "start") {
      const started = await runtime.startTransaction({
        idempotencyKey,
        fundingReference: "funding-reference-process",
        privateDocument: "PROCESS-DOCUMENT-MARKER PROCESS-RESULT-MARKER Bitcoin Cashu settlement document.",
        mediaType: "text/plain",
        privatePrompt: "PROCESS-PROMPT-MARKER Return PROCESS-RESULT-MARKER with the summary.",
        maximumBudgetSats: sats(500n),
      });
      emit("result", { transactionId: started.transactionId, report: started.report });
    } else if (action === "resume") {
      const transactionId = requiredEnvironment("PACT_PROCESS_TRANSACTION_ID");
      const report = await runtime.resume(transactionId);
      emit("result", { transactionId, report });
    } else if (action === "status") {
      const transactionId = requiredEnvironment("PACT_PROCESS_TRANSACTION_ID");
      emit("result", { transactionId, status: await runtime.status(transactionId) });
    } else {
      throw new Error(`Unknown process action: ${action}`);
    }
  } catch (error) {
    emit("error", {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    await runtime.shutdown();
    closeStores();
  }
}

async function dispatchHttp(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
  const method = incoming.method ?? "GET";
  const request = new Request(url, {
    method,
    headers: incoming.headers as HeadersInit,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks).toString("utf8") }),
  });
  const parts = url.pathname.split("/").filter(Boolean);
  let response: Response;
  if (url.pathname === "/api/transactions" && method === "POST") {
    response = await postTransaction(request);
  } else if (parts[0] === "api" && parts[1] === "transactions" && parts[2]) {
    const context = { params: Promise.resolve({ id: parts[2] }) };
    if (parts.length === 3 && method === "GET") response = await getTransaction(request, context);
    else if (parts[3] === "report" && method === "GET") response = await getTransactionReport(request, context);
    else if (parts[3] === "result" && method === "GET") response = await getTransactionResult(request, context);
    else if (parts[3] === "resume" && method === "POST") response = await resumeTransaction(request, context);
    else if (parts[3] === "reconcile" && method === "POST") response = await reconcileTransaction(request, context);
    else response = new Response("Not found", { status: 404 });
  } else {
    response = new Response("Not found", { status: 404 });
  }
  const headers = Object.fromEntries(response.headers.entries());
  outgoing.writeHead(response.status, headers);
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

void run().catch((error) => {
  emit("fatal", { message: error instanceof Error ? error.message : "Unknown error" });
  process.exitCode = 1;
});
