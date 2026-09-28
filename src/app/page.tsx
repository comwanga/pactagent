"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  PactAgentApiClient,
  clearAllRetained,
  clearRetainedIdempotencyKey,
  clearRetainedTransactionId,
  friendlyErrorMessage,
  isNotFoundError,
  isWorkflowReport,
  loadRetainedIdempotencyKey,
  loadRetainedTransactionId,
  retainIdempotencyKey,
  retainTransactionId,
  type RuntimeBootstrap,
  type RuntimePhase,
  type SessionInfo,
  type TransactionStatus,
  type WorkflowReport,
  type PrivateResult,
} from "@/lib/pactagent-api-client";

import { ActivityEntry } from "./components/activity-log";
import { ConnectPanel, type ConnectResult } from "./components/connect-panel";
import { TransactionForm, type TransactionFormInput } from "./components/transaction-form";
import { TransactionDetail } from "./components/transaction-detail";
import { ToastViewport, useToast } from "./components/use-toast";
import { PactAgentLogo } from "./pactagent-logo";

const POLL_INTERVAL_MS = 1_000;
const POLL_BACKOFF_MAX_MS = 4_000;

type View = "landing" | "form" | "transaction";

export default function Home(): React.ReactElement {
  const [view, setView] = useState<View>("landing");
  const [client, setClient] = useState<PactAgentApiClient | undefined>();
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | undefined>();
  const [bootstrap, setBootstrap] = useState<RuntimeBootstrap | undefined>();
  const [transactionId, setTransactionId] = useState<string | undefined>(() => loadRetainedTransactionId());
  const [idempotencyKey, setIdempotencyKey] = useState<string | undefined>(() => loadRetainedIdempotencyKey());
  const [status, setStatus] = useState<TransactionStatus | undefined>();
  const [report, setReport] = useState<WorkflowReport | undefined>();
  const [privateResult, setPrivateResult] = useState<PrivateResult | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [actionInFlight, setActionInFlight] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [activity, setActivity] = useState<readonly ActivityEntry[]>([]);
  const [polling, setPolling] = useState(false);
  const [pollGeneration, setPollGeneration] = useState(0);
  const [lastUpdatedMs, setLastUpdatedMs] = useState<number | undefined>();
  const [bootstrapping, setBootstrapping] = useState(true);
  const toast = useToast();
  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const backoffRef = useRef(POLL_INTERVAL_MS);
  const lastPhaseRef = useRef<RuntimePhase | undefined>(undefined);

  // On mount, probe for an existing httpOnly session so refresh survives.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBootstrapping(true);
      const probe = new PactAgentApiClient();
      try {
        const info = await probe.getSession();
        if (cancelled) return;
        setSessionInfo(info);
        if (info.authenticated) {
          setClient(probe);
          try {
            const ready = await probe.bootstrap();
            if (cancelled) return;
            setBootstrap(ready);
          } catch (err) {
            if (cancelled) return;
            setError(friendlyErrorMessage(err));
          }
          if (loadRetainedTransactionId()) {
            setView("transaction");
          } else {
            setView("form");
          }
        }
      } catch {
        // No session; stay on landing.
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const recordActivity = useCallback((phase: RuntimePhase): void => {
    setActivity((current) => {
      if (current.length > 0 && current[current.length - 1].phase === phase) return current;
      const entry: ActivityEntry = {
        id: `${phase}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        phase,
        timestamp: Date.now(),
      };
      return [...current, entry];
    });
  }, []);

  const handleConnected = useCallback(
    async (result: ConnectResult): Promise<void> => {
      setClient(result.client);
      setSessionInfo(result.session);
      setError(undefined);
      try {
        const ready = await result.client.bootstrap();
        setBootstrap(ready);
      } catch (err) {
        setError(friendlyErrorMessage(err));
      }
      if (loadRetainedTransactionId()) {
        setView("transaction");
      } else {
        setView("form");
      }
    },
    [],
  );

  const handleSubmit = useCallback(
    async (input: TransactionFormInput): Promise<void> => {
      if (!client) return;
      setSubmitting(true);
      setError(undefined);
      try {
        const result = await client.startTransaction({
          idempotencyKey: input.idempotencyKey,
          privateDocument: input.document,
          mediaType: input.mediaType,
          ...(input.prompt ? { privatePrompt: input.prompt } : {}),
          maximumBudgetSats: input.budgetSats,
        });
        setTransactionId(result.transactionId);
        setIdempotencyKey(input.idempotencyKey);
        retainTransactionId(result.transactionId);
        retainIdempotencyKey(input.idempotencyKey);
        setActivity([]);
        lastPhaseRef.current = undefined;
        setReport(undefined);
        setPrivateResult(undefined);
        setView("transaction");
        toast.push("Transaction submitted — agent is starting", "success");
      } catch (err) {
        const message = friendlyErrorMessage(err);
        setError(message);
        toast.push(message, "error");
      } finally {
        setSubmitting(false);
      }
    },
    [client, toast],
  );

  const handleResume = useCallback(async (): Promise<void> => {
    if (!client || !transactionId) return;
    setActionInFlight(true);
    setError(undefined);
    try {
      const r = await client.resume(transactionId);
      setReport(r);
      setStatus(await client.getStatus(transactionId));
      setPollGeneration((generation) => generation + 1);
      toast.push("Resumed — agent is continuing", "success");
    } catch (err) {
      const message = friendlyErrorMessage(err);
      setError(message);
      toast.push(message, "error");
    } finally {
      setActionInFlight(false);
    }
  }, [client, transactionId, toast]);

  const handleReconcile = useCallback(async (): Promise<void> => {
    if (!client || !transactionId) return;
    setActionInFlight(true);
    setError(undefined);
    try {
      const result = await client.reconcile(transactionId);
      if (isWorkflowReport(result)) setReport(result);
      setStatus(await client.getStatus(transactionId));
      setPollGeneration((generation) => generation + 1);
      toast.push("Reconciliation complete", "success");
    } catch (err) {
      const message = friendlyErrorMessage(err);
      setError(message);
      toast.push(message, "error");
    } finally {
      setActionInFlight(false);
    }
  }, [client, transactionId, toast]);

  const handleFetchReport = useCallback(async (): Promise<void> => {
    if (!client || !transactionId) return;
    setActionInFlight(true);
    setError(undefined);
    try {
      const r = await client.getReport(transactionId);
      setReport(r);
      toast.push("Safe report retrieved", "success");
    } catch (err) {
      const message = friendlyErrorMessage(err);
      setError(message);
      toast.push(message, "error");
    } finally {
      setActionInFlight(false);
    }
  }, [client, transactionId, toast]);

  const handleFetchResult = useCallback(async (): Promise<void> => {
    if (!client || !transactionId) return;
    setActionInFlight(true);
    setError(undefined);
    try {
      const r = await client.getPrivateResult(transactionId);
      setPrivateResult(r);
      toast.push("Private summary retrieved", "success");
    } catch (err) {
      const message = friendlyErrorMessage(err);
      setError(message);
      toast.push(message, "error");
    } finally {
      setActionInFlight(false);
    }
  }, [client, transactionId, toast]);

  const handleCloseTransaction = useCallback((): void => {
    clearRetainedTransactionId();
    clearRetainedIdempotencyKey();
    setTransactionId(undefined);
    setIdempotencyKey(undefined);
    setStatus(undefined);
    setReport(undefined);
    setPrivateResult(undefined);
    setActivity([]);
    lastPhaseRef.current = undefined;
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = undefined;
    }
    setView("form");
  }, []);

  const handleSignOut = useCallback(async (): Promise<void> => {
    if (client) {
      try {
        await client.endSession();
      } catch {
        // Best-effort cookie clear.
      }
    }
    clearAllRetained();
    setClient(undefined);
    setSessionInfo(undefined);
    setBootstrap(undefined);
    setTransactionId(undefined);
    setIdempotencyKey(undefined);
    setStatus(undefined);
    setReport(undefined);
    setPrivateResult(undefined);
    setActivity([]);
    lastPhaseRef.current = undefined;
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = undefined;
    }
    setView("landing");
    toast.push("Signed out", "info");
  }, [client, toast]);

  // Poll status; diff phase transitions into the activity log.
  useEffect(() => {
    if (!client || !transactionId) return;
    let cancelled = false;
    backoffRef.current = POLL_INTERVAL_MS;

    const doPoll = async (): Promise<void> => {
      setPolling(true);
      try {
        const s = await client.getStatus(transactionId);
        if (cancelled) return;
        setStatus(s);
        setLastUpdatedMs(Date.now());
        backoffRef.current = POLL_INTERVAL_MS;

        if (lastPhaseRef.current !== s.phase) {
          recordActivity(s.phase);
          lastPhaseRef.current = s.phase;
        }

        const terminal =
          s.finalOutcome === "settled" ||
          s.finalOutcome === "refunded" ||
          s.operationalState === "failed" ||
          s.operationalState === "reconciliation_required";
        if (terminal) {
          setPolling(false);
          if (s.finalOutcome === "settled") toast.push("Pact settled — complete", "success");
          else if (s.finalOutcome === "refunded") toast.push("Pact refunded", "info");
          else if (s.operationalState === "reconciliation_required") toast.push("Reconciliation required", "error");
          return;
        }
        pollRef.current = setTimeout(() => void doPoll(), backoffRef.current);
      } catch (err) {
        if (cancelled) return;
        setPolling(false);
        if (isNotFoundError(err)) {
          // Transaction gone (runtime reset) — recover gracefully.
          toast.push("This transaction no longer exists on the runtime.", "error");
          handleCloseTransaction();
          return;
        }
        // Transient error: back off and keep trying without a sticky banner.
        backoffRef.current = Math.min(backoffRef.current * 2, POLL_BACKOFF_MAX_MS);
        pollRef.current = setTimeout(() => void doPoll(), backoffRef.current);
      }
    };

    void doPoll();
    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = undefined;
      }
    };
  }, [client, transactionId, pollGeneration, recordActivity, toast, handleCloseTransaction]);

  const demoAvailable = useMemo(() => sessionInfo?.demoAvailable ?? false, [sessionInfo]);

  return (
    <main>
      <section className="hero">
        <nav aria-label="Project identity">
          <PactAgentLogo />
        </nav>
        <div className="heroCopy">
          <p className="eyebrow">Application-level machine economy</p>
          <h1>Agents make pacts.<br /><em>Protocols keep the truth.</em></h1>
          <p className="lede">
            Submit a private document. An autonomous agent discovers a provider, signs a service agreement,
            funds Cashu escrow, executes the summary, and settles — all over Nostr and Cashu.
          </p>
        </div>
      </section>

      {view === "landing" && (
        bootstrapping ? (
          <section className="section">
            <p role="status" aria-live="polite">Checking for an existing session…</p>
          </section>
        ) : (
          <ConnectPanel
            demoAvailable={demoAvailable}
            onConnected={handleConnected}
            busy={false}
          />
        )
      )}

      {view === "form" && bootstrap && client && (
        <TransactionForm
          bootstrap={bootstrap}
          submitting={submitting}
          onSubmit={handleSubmit}
          error={error}
        />
      )}

      {view === "form" && !bootstrap && client && (
        <section className="section">
          <p role="status" aria-live="polite">Contacting the runtime…</p>
          {error && (
            <>
              <p role="alert" className="errorText">{error}</p>
              <button
                type="button"
                className="primaryBtn"
                onClick={() => {
                  if (!client) return;
                  setError(undefined);
                  client.bootstrap().then(setBootstrap).catch((err) => setError(friendlyErrorMessage(err)));
                }}
              >
                Retry
              </button>
            </>
          )}
        </section>
      )}

      {view === "transaction" && status && (
        <TransactionDetail
          status={status}
          report={report}
          privateResult={privateResult}
          idempotencyKey={idempotencyKey}
          actionInFlight={actionInFlight}
          polling={polling}
          activity={activity}
          lastUpdatedMs={lastUpdatedMs}
          error={error}
          onResume={handleResume}
          onReconcile={handleReconcile}
          onFetchReport={handleFetchReport}
          onFetchResult={handleFetchResult}
          onClose={handleCloseTransaction}
          onSignOut={handleSignOut}
        />
      )}

      {view === "transaction" && !status && (
        <section className="section">
          <p role="status" aria-live="polite">Loading transaction status…</p>
        </section>
      )}

      <footer>
        <span>PactAgent</span>
        <span>BOSS Battle 2026 · Freedom Stack + Machine Money</span>
      </footer>

      <ToastViewport {...toast} />
    </main>
  );
}
