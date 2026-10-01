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
import Link from "next/link";

const POLL_INTERVAL_MS = 1_000;
const POLL_BACKOFF_MAX_MS = 4_000;

type View = "landing" | "form" | "transaction";

export default function Home(): React.ReactElement {
  const [view, setView] = useState<View>("landing");
  const [client, setClient] = useState<PactAgentApiClient | undefined>();
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | undefined>();
  const [bootstrap, setBootstrap] = useState<RuntimeBootstrap | undefined>();
  const [transactionId, setTransactionId] = useState<string | undefined>(() => loadRetainedTransactionId());
  const [, setIdempotencyKey] = useState<string | undefined>(() => loadRetainedIdempotencyKey());
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
  const { push: toastPush } = toast;
  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const backoffRef = useRef(POLL_INTERVAL_MS);
  const lastPhaseRef = useRef<RuntimePhase | undefined>(undefined);

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
          const retainedTxn = loadRetainedTransactionId();
          if (retainedTxn) {
            try {
              await probe.getStatus(retainedTxn);
              if (cancelled) return;
              setView("transaction");
            } catch {
              clearRetainedTransactionId();
              clearRetainedIdempotencyKey();
              setTransactionId(undefined);
              setView("form");
            }
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
    return () => { cancelled = true; };
  }, []);

  const recordActivity = useCallback((phase: RuntimePhase): void => {
    setActivity((current) => {
      if (current.length > 0 && current[current.length - 1].phase === phase) return current;
      return [...current, {
        id: `${phase}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        phase,
        timestamp: Date.now(),
      }];
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
      setView(loadRetainedTransactionId() ? "transaction" : "form");
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
        toastPush("Transaction submitted — agent is starting", "success");
      } catch (err) {
        const message = friendlyErrorMessage(err);
        setError(message);
        toastPush(message, "error");
      } finally {
        setSubmitting(false);
      }
    },
    [client, toastPush],
  );

  const handleResume = useCallback(async (): Promise<void> => {
    if (!client || !transactionId) return;
    setActionInFlight(true);
    setError(undefined);
    try {
      const r = await client.resume(transactionId);
      if (isWorkflowReport(r)) setReport(r);
      setStatus(await client.getStatus(transactionId));
      setPollGeneration((g) => g + 1);
      toastPush("Resumed — agent is continuing", "success");
    } catch (err) {
      setError(friendlyErrorMessage(err));
      toastPush(friendlyErrorMessage(err), "error");
    } finally {
      setActionInFlight(false);
    }
  }, [client, transactionId, toastPush]);

  const handleReconcile = useCallback(async (): Promise<void> => {
    if (!client || !transactionId) return;
    setActionInFlight(true);
    setError(undefined);
    try {
      const result = await client.reconcile(transactionId);
      if (isWorkflowReport(result)) setReport(result);
      setStatus(await client.getStatus(transactionId));
      setPollGeneration((g) => g + 1);
      toastPush("Reconciliation complete", "success");
    } catch (err) {
      setError(friendlyErrorMessage(err));
      toastPush(friendlyErrorMessage(err), "error");
    } finally {
      setActionInFlight(false);
    }
  }, [client, transactionId, toastPush]);

  const handleFetchReport = useCallback(async (): Promise<void> => {
    if (!client || !transactionId) return;
    setActionInFlight(true);
    try {
      const r = await client.getReport(transactionId);
      setReport(r);
      toastPush("Report retrieved", "success");
    } catch (err) {
      toastPush(friendlyErrorMessage(err), "error");
    } finally {
      setActionInFlight(false);
    }
  }, [client, transactionId, toastPush]);

  const handleFetchResult = useCallback(async (): Promise<void> => {
    if (!client || !transactionId) return;
    setActionInFlight(true);
    try {
      const r = await client.getPrivateResult(transactionId);
      setPrivateResult(r);
      toastPush("Summary retrieved", "success");
    } catch (err) {
      toastPush(friendlyErrorMessage(err), "error");
    } finally {
      setActionInFlight(false);
    }
  }, [client, transactionId, toastPush]);

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
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = undefined; }
    setView("form");
  }, []);

  const handleSignOut = useCallback(async (): Promise<void> => {
    if (client) { try { await client.endSession(); } catch { /* best-effort */ } }
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
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = undefined; }
    setView("landing");
    toastPush("Signed out", "info");
  }, [client, toastPush]);

  // Poll status
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
          if (s.finalOutcome === "settled" && !privateResult && s.resultAvailable) {
            // Auto-fetch result on settle
            try {
              const r = await client.getPrivateResult(transactionId);
              if (!cancelled) setPrivateResult(r);
            } catch { /* non-critical */ }
          }
          if (s.finalOutcome === "settled") toastPush("Pact settled — complete", "success");
          else if (s.finalOutcome === "refunded") toastPush("Pact refunded", "info");
          else if (s.operationalState === "reconciliation_required") toastPush("Reconciliation required", "error");
          return;
        }
        pollRef.current = setTimeout(() => void doPoll(), backoffRef.current);
      } catch (err) {
        if (cancelled) return;
        setPolling(false);
        if (isNotFoundError(err)) {
          toastPush("Transaction no longer exists.", "error");
          handleCloseTransaction();
          return;
        }
        backoffRef.current = Math.min(backoffRef.current * 2, POLL_BACKOFF_MAX_MS);
        pollRef.current = setTimeout(() => void doPoll(), backoffRef.current);
      }
    };

    void doPoll();
    return () => {
      cancelled = true;
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = undefined; }
    };
  }, [client, transactionId, pollGeneration, recordActivity, toastPush, handleCloseTransaction, privateResult]);

  const demoAvailable = useMemo(() => sessionInfo?.demoAvailable ?? false, [sessionInfo]);

  return (
    <div className="appShell">
      <header className="topBar">
        <Link href="/" className="brandLink" aria-label="PactAgent home">
          <svg className="brandMark" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
            <path className="brandGlyph" d="M18 2L33 11v14L18 34L3 25V11L18 2z" />
            <path className="brandRibbon" d="M18 8L27 13v10L18 28L9 23V13L18 8z" />
            <circle className="brandJoint" cx="18" cy="18" r="3" />
          </svg>
          <span className="brandWordmark"><strong>PACT</strong>AGENT</span>
        </Link>
        <span className="topBarTag">Open protocols · Machine money</span>
        {view !== "landing" && (
          <button type="button" className="signOutLink" onClick={handleSignOut}>Sign out</button>
        )}
      </header>

      <div className="viewContainer">
        {view === "landing" && (
          bootstrapping ? (
            <div className="loadingState">Checking for an existing session…</div>
          ) : (
            <ConnectPanel demoAvailable={demoAvailable} onConnected={handleConnected} busy={false} />
          )
        )}

        {view === "form" && bootstrap && client && (
          <TransactionForm bootstrap={bootstrap} submitting={submitting} onSubmit={handleSubmit} error={error} />
        )}

        {view === "form" && !bootstrap && client && (
          <div className="loadingState">
            <div>
              <p>Contacting the runtime…</p>
              {error && <p className="errorBanner" style={{ marginTop: 12 }}>{error}</p>}
            </div>
          </div>
        )}

        {view === "transaction" && status && (
          <TransactionDetail
            status={status}
            report={report}
            privateResult={privateResult}
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
          />
        )}

        {view === "transaction" && !status && (
          <div className="loadingState">Loading transaction…</div>
        )}
      </div>

      <ToastViewport {...toast} />
    </div>
  );
}
