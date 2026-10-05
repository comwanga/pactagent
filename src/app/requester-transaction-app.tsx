"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

import {
  RequesterApiClient,
  RequesterApiClientError,
  type RequesterTransactionApi,
  type RequesterTransactionSubmission,
} from "@/lib/requester-api-client";
import type {
  RequesterApiErrorCode,
  RequesterDemoWallet,
  RequesterOperationalState,
  RequesterPrivateResult,
  RequesterSafeReport,
  RequesterTransactionStatus,
} from "@/lib/requester-api-contracts";
import {
  abbreviateReference,
  formatByteSize,
  isPromptWithinLimit,
  parseWholeSatBudget,
  prepareRequesterDocument,
  promptBytes,
  RequesterDocumentValidationError,
  REQUESTER_DOCUMENT_MAXIMUM_BYTES,
  REQUESTER_PROMPT_MAXIMUM_BYTES,
  type PreparedRequesterDocument,
} from "@/lib/requester-ui-model";

import { PactAgentLogo } from "./pactagent-logo";

type Screen = "landing" | "form" | "review" | "status";
type RecoveryAction = "resume" | "reconcile" | "refund";

interface FormErrors {
  document?: string;
  budget?: string;
  prompt?: string;
}

function withoutFormError(errors: FormErrors, key: keyof FormErrors): FormErrors {
  const next = { ...errors };
  delete next[key];
  return next;
}

export interface RequesterTransactionAppProps {
  readonly api?: RequesterTransactionApi;
  readonly pollIntervalMs?: number;
}

const SUCCESS_PHASES = [
  "initialized",
  "proposed",
  "accepted",
  "escrow_funded",
  "task_delivered",
  "result_submitted",
  "result_verified",
  "release_authorized",
  "settled",
] as const;

const POLICY_CHECKS = [
  ["selectedProviderMatchesDiscovery", "Selected provider matches validated discovery"],
  ["stableReferencesMatch", "Stable provider and offer references match"],
  ["withinRequesterBudget", "Offer is within the requester budget"],
  ["cashuCompatible", "Cashu settlement is permitted"],
  ["priceAllowed", "Signed offer price is allowed"],
  ["executionDurationAllowed", "Execution duration is within policy"],
] as const;

const OPERATIONAL_COPY: Readonly<Record<RequesterOperationalState, string>> = {
  active: "The runtime reports that this transaction is active.",
  failed: "The runtime reported a redacted transaction failure.",
  reconciliation_required: "The runtime requires reconciliation. No automatic economic retry will be attempted.",
  resolved_not_funded: "The runtime resolved this transaction without funding it.",
  refunded: "The runtime reports that the transaction was refunded.",
  settled: "The runtime reports that the transaction settled.",
};

const ERROR_COPY: Readonly<Partial<Record<RequesterApiErrorCode, string>>> = {
  unauthorized: "This requester is not authorized to use the transaction service.",
  invalid_request: "The transaction request was rejected as invalid.",
  document_too_large: "The document exceeds the 1 MiB upload limit.",
  result_not_available: "The private result is not available yet.",
  report_not_available: "The safe transaction report is not available yet.",
  runtime_unavailable: "The transaction service is temporarily unavailable.",
  transaction_not_found: "The transaction was not found.",
  transaction_in_progress: "The transaction is already in progress.",
  reconciliation_required: "The runtime reports that reconciliation is required.",
  transaction_not_completed:
    "The transaction could not be completed yet. You can try again, or refund the escrow once the timeout has passed.",
  internal_error: "The transaction service could not complete the request.",
  upstream_invalid_response: "The transaction service returned an invalid response.",
  corrupt_record: "The transaction record is unavailable.",
  invalid_configuration: "The transaction service is not configured.",
  not_running: "The transaction service is not running.",
};

export function redactedUiError(error: unknown): string {
  if (error instanceof RequesterApiClientError) {
    return ERROR_COPY[error.detail.code] ?? "The transaction service could not complete the request.";
  }
  return "The transaction service could not complete the request.";
}

function documentError(error: unknown): string {
  if (!(error instanceof RequesterDocumentValidationError)) {
    return "The selected document could not be read.";
  }
  switch (error.code) {
    case "unsupported_media_type":
      return "Choose a text/plain or application/pdf document.";
    case "document_too_large":
      return `The original document must not exceed ${formatByteSize(REQUESTER_DOCUMENT_MAXIMUM_BYTES)}.`;
    case "document_empty":
      return "Choose a non-empty document.";
    default:
      return "The selected document could not be read.";
  }
}

function ProtocolHeader(): React.ReactNode {
  return (
    <header className="appHeader">
      <nav aria-label="Project identity"><PactAgentLogo /></nav>
      <p className="environmentFlag">Integrated PoC · test ecash only · no real sats</p>
    </header>
  );
}

export function TrustBoundary({
  privateResultLoaded = false,
}: {
  readonly privateResultLoaded?: boolean;
}): React.ReactNode {
  return (
    <section className="trustBoundary" aria-labelledby="trust-boundary-heading">
      <div>
        <p className="eyebrow dark">Trust boundary</p>
        <h2 id="trust-boundary-heading">Public-shaped facts. Private payloads.</h2>
        <p>
          PactAgent shows allowlisted runtime projections without inspecting private material to prove
          that it remains private.
        </p>
      </div>
      <div className="trustColumns">
        <article>
          <h3>Safe transaction projection</h3>
          <ul>
            <li>Provider identity and stable references</li>
            <li>Signed offer amount and unit</li>
            <li>Authoritative lifecycle state</li>
            <li>Terminal references returned by the runtime</li>
            <li>Safe terminal transaction report</li>
          </ul>
        </article>
        <article className="privateCard">
          <h3>Private by design</h3>
          <ul>
            <li>Source document and requester prompt</li>
            <li>
              Complete private result
              {privateResultLoaded ? " — currently loaded in this browser session" : ""}
            </li>
            <li>Cashu proofs, secrets, and funding material</li>
            <li>Signing/encryption keys and commitment salts</li>
          </ul>
        </article>
      </div>
    </section>
  );
}

function Lifecycle({ status }: { readonly status: RequesterTransactionStatus }): React.ReactNode {
  const currentIndex = SUCCESS_PHASES.indexOf(status.phase as (typeof SUCCESS_PHASES)[number]);
  if (status.kind === "refund" || currentIndex === -1) {
    return (
      <section className="lifecyclePanel" aria-labelledby="lifecycle-heading">
        <p className="sectionKicker">Authoritative lifecycle</p>
        <h3 id="lifecycle-heading">Current phase</h3>
        <p className="currentPhase"><code>{status.phase}</code></p>
        <p>This transaction is not being presented as a successful settlement path.</p>
      </section>
    );
  }
  return (
    <section className="lifecyclePanel" aria-labelledby="lifecycle-heading">
      <p className="sectionKicker">Authoritative lifecycle</p>
      <h3 id="lifecycle-heading">Current phase: <code>{status.phase}</code></h3>
      <ol className="lifecycleList">
        {SUCCESS_PHASES.map((phase, index) => {
          const state = index < currentIndex ? "completed" : index === currentIndex ? "current" : "pending";
          return (
            <li key={phase} data-step-state={state}>
              <span aria-hidden="true">{index + 1}</span>
              <code>{phase}</code>
              <small>{state}</small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function SelectedOffer({ status }: { readonly status: RequesterTransactionStatus }): React.ReactNode {
  const offer = status.selectedOffer;
  return (
    <section className="dataPanel" aria-labelledby="selected-offer-heading">
      <p className="sectionKicker">Runtime-validated signed offer</p>
      <h3 id="selected-offer-heading">Selected provider</h3>
      <dl className="detailList">
        <div><dt>Provider public key</dt><dd><code>{abbreviateReference(offer.providerPublicKey)}</code></dd></div>
        <div><dt>Provider definition</dt><dd><code>{abbreviateReference(offer.providerDefinitionReference)}</code></dd></div>
        <div><dt>Offer reference</dt><dd><code>{abbreviateReference(offer.offerReference)}</code></dd></div>
        <div><dt>Escrow descriptor</dt><dd><code>{abbreviateReference(offer.escrowDescriptorReference)}</code></dd></div>
        <div><dt>Signed amount</dt><dd className="offerAmount">{offer.amountSats} {offer.unit === "sat" ? "sats" : offer.unit}</dd></div>
      </dl>
    </section>
  );
}

function RequesterDecision({ status }: { readonly status: RequesterTransactionStatus }): React.ReactNode {
  const decision = status.requesterDecision;
  if (!decision) {
    return (
      <section className="decisionPanel" aria-labelledby="decision-heading">
        <p className="sectionKicker">Requester-decision boundary</p>
        <h3 id="decision-heading">Waiting for the runtime decision projection</h3>
        <p>No browser-side recommendation or policy result is inferred.</p>
      </section>
    );
  }
  return (
    <section className="decisionPanel" aria-labelledby="decision-heading">
      <p className="sectionKicker">Requester-decision boundary</p>
      <h3 id="decision-heading">Recommendation is advisory. Policy authorizes.</h3>
      <div className="decisionGrid">
        <article>
          <p className="decisionType">AI/model recommendation · advisory</p>
          <dl className="compactDetails">
            <div><dt>Source</dt><dd><code>{decision.source}</code></dd></div>
            <div><dt>Provider</dt><dd><code>{abbreviateReference(decision.recommendation.providerPublicKey)}</code></dd></div>
            <div><dt>Offer</dt><dd><code>{abbreviateReference(decision.recommendation.offerReference)}</code></dd></div>
            <div><dt>Amount</dt><dd>{decision.recommendation.amountSats} sats</dd></div>
          </dl>
        </article>
        <article className="policyCard">
          <p className="decisionType">Deterministic policy · authorization boundary</p>
          <ul className="policyChecks">
            {POLICY_CHECKS.map(([key, label]) => (
              <li key={key}>
                <span aria-hidden="true">✓</span>
                <span>{label}</span>
                <strong>{decision.policy[key] ? "passed" : "not passed"}</strong>
              </li>
            ))}
          </ul>
          <p className="authorizationOutcome">Authorized: <strong>{decision.authorized ? "yes" : "no"}</strong></p>
        </article>
      </div>
    </section>
  );
}

export function PrivateResultPanel({
  available,
  result,
  loading,
  error,
  onLoad,
}: {
  readonly available: boolean;
  readonly result?: RequesterPrivateResult;
  readonly loading: boolean;
  readonly error?: string;
  readonly onLoad: () => void;
}): React.ReactNode {
  return (
    <section className="privateResultPanel" aria-labelledby="private-result-heading" aria-busy={loading}>
      <p className="sectionKicker">Requester-private information</p>
      <h2 id="private-result-heading">Private result</h2>
      <p className="resourceExplanation">
        This complete summary is private to the requester. It is not public lifecycle evidence and is
        kept only in this browser&apos;s current in-memory transaction session.
      </p>
      {result ? (
        <div className="privateSummary" data-private-result="loaded">
          <p>{result.summary}</p>
        </div>
      ) : available ? (
        <button
          className="primaryAction compact"
          type="button"
          disabled={loading}
          aria-describedby={error ? "private-result-error" : undefined}
          onClick={onLoad}
        >
          {loading ? "Loading private result…" : error ? "Retry private result" : "Load private result"}
        </button>
      ) : (
        <p className="resourcePending">The runtime has not made a private result available.</p>
      )}
      {error ? <p className="resourceError" id="private-result-error" role="alert">{error}</p> : null}
    </section>
  );
}

export function SafeReportPanel({
  available,
  report,
  loading,
  error,
  onLoad,
}: {
  readonly available: boolean;
  readonly report?: RequesterSafeReport;
  readonly loading: boolean;
  readonly error?: string;
  readonly onLoad: () => void;
}): React.ReactNode {
  return (
    <section className="safeReportPanel" aria-labelledby="safe-report-heading" aria-busy={loading}>
      <p className="sectionKicker">Public-shaped terminal evidence</p>
      <h2 id="safe-report-heading">Safe transaction report</h2>
      <p className="resourceExplanation">
        This is the allowlisted terminal report returned by the runtime. It remains structurally
        separate from the requester-private result.
      </p>
      {report ? (
        <div data-safe-report="loaded">
          <dl className="reportDetails">
            <div><dt>Agreement</dt><dd><code>{abbreviateReference(report.agreementId)}</code></dd></div>
            <div><dt>Agreement root</dt><dd><code>{abbreviateReference(report.agreementRootEventId)}</code></dd></div>
            <div><dt>Requester</dt><dd><code>{abbreviateReference(report.requesterPublicKey)}</code></dd></div>
            <div><dt>Provider</dt><dd><code>{abbreviateReference(report.providerPublicKey)}</code></dd></div>
            <div><dt>Escrow authority</dt><dd><code>{abbreviateReference(report.escrowAuthorityPublicKey)}</code></dd></div>
            <div><dt>Provider definition</dt><dd><code>{abbreviateReference(report.selectedReferences.providerDefinitionReference)}</code></dd></div>
            <div><dt>Offer reference</dt><dd><code>{abbreviateReference(report.selectedReferences.offerReference)}</code></dd></div>
            <div><dt>Escrow descriptor</dt><dd><code>{abbreviateReference(report.selectedReferences.escrowDescriptorReference)}</code></dd></div>
            <div><dt>Amount</dt><dd>{report.amountSats} {report.unit === "sat" ? "sats" : report.unit}</dd></div>
            <div><dt>Terminal outcome</dt><dd><code>{report.finalOutcome}</code></dd></div>
            <div><dt>Escrow reference</dt><dd><code>{abbreviateReference(report.escrowReference)}</code></dd></div>
            {report.resultReference ? <div><dt>Result reference</dt><dd><code>{abbreviateReference(report.resultReference)}</code></dd></div> : null}
            {report.settlementReference ? <div><dt>Settlement reference</dt><dd><code>{abbreviateReference(report.settlementReference)}</code></dd></div> : null}
            {report.refundReference ? <div><dt>Refund reference</dt><dd><code>{abbreviateReference(report.refundReference)}</code></dd></div> : null}
          </dl>
          <h3 className="reportLifecycleHeading">Canonical lifecycle/history</h3>
          <ol className="reportLifecycle">
            {report.lifecycle.map((transition, index) => (
              <li key={`${transition.eventId}-${index}`}>
                <code>{transition.state}</code>
                <span><code>{abbreviateReference(transition.eventId)}</code></span>
              </li>
            ))}
          </ol>
        </div>
      ) : available ? (
        <button
          className="secondaryAction"
          type="button"
          disabled={loading}
          aria-describedby={error ? "safe-report-error" : undefined}
          onClick={onLoad}
        >
          {loading ? "Loading safe report…" : error ? "Retry safe report" : "Load safe transaction report"}
        </button>
      ) : (
        <p className="resourcePending">The runtime has not made a safe terminal report available.</p>
      )}
      {error ? <p className="resourceError" id="safe-report-error" role="alert">{error}</p> : null}
    </section>
  );
}

export function TransactionStatusView({
  status,
  headingRef,
}: {
  readonly status: RequesterTransactionStatus;
  readonly headingRef?: React.Ref<HTMLHeadingElement>;
}): React.ReactNode {
  return (
    <div className="statusSurface" data-operational-state={status.operationalState}>
      <section className="statusSummary" aria-labelledby="transaction-status-heading">
        <div>
          <p className="eyebrow dark">Authoritative runtime status</p>
          <h1 id="transaction-status-heading" ref={headingRef} tabIndex={-1}>Transaction status</h1>
        </div>
        <div className="stateCard">
          <span>Operational state</span>
          <strong><code>{status.operationalState}</code></strong>
          <p>{OPERATIONAL_COPY[status.operationalState]}</p>
        </div>
      </section>
      <div className="statusIdentifiers">
        <p><span>Transaction ID</span><code>{status.transactionId}</code></p>
        <p><span>Phase</span><code>{status.phase}</code></p>
        {status.finalOutcome ? <p><span>Final outcome</span><code>{status.finalOutcome}</code></p> : null}
        {status.reconciliationState ? <p><span>Reconciliation state</span><code>{status.reconciliationState}</code></p> : null}
        {status.failureCode ? <p><span>Failure code</span><code>{status.failureCode}</code></p> : null}
        {status.failureReason === "private_task_transport_too_large" ? (
          <div className="failureReasonNotice" role="alert">
            Private delivery capacity is temporarily unavailable. No escrow was funded; please retry later.
          </div>
        ) : null}
      </div>
      {status.operationalState === "reconciliation_required" ? (
        <div className="interruptNotice" role="status">
          Reconciliation is required. PactAgent will act only when the runtime exposes reconciliation and
          the requester explicitly confirms inspection of existing state.
        </div>
      ) : null}
      <Lifecycle status={status} />
      <div className="statusGridTwo">
        <SelectedOffer status={status} />
        <RequesterDecision status={status} />
      </div>
    </div>
  );
}

export function RequesterTransactionApp({
  api,
  pollIntervalMs = 2_500,
}: RequesterTransactionAppProps): React.ReactNode {
  const client = useMemo<RequesterTransactionApi>(() => api ?? new RequesterApiClient(), [api]);
  const [screen, setScreen] = useState<Screen>("landing");
  const [sessionChecking, setSessionChecking] = useState(true);
  const [sessionError, setSessionError] = useState<string>();
  const [document, setDocument] = useState<PreparedRequesterDocument>();
  const [budget, setBudget] = useState("500");
  const [prompt, setPrompt] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [documentBusy, setDocumentBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string>();
  const [transactionId, setTransactionId] = useState<string>();
  const [status, setStatus] = useState<RequesterTransactionStatus>();
  const [statusError, setStatusError] = useState<string>();
  const [polling, setPolling] = useState(false);
  const [privateResult, setPrivateResult] = useState<RequesterPrivateResult>();
  const [privateResultLoading, setPrivateResultLoading] = useState(false);
  const [privateResultError, setPrivateResultError] = useState<string>();
  const [safeReport, setSafeReport] = useState<RequesterSafeReport>();
  const [safeReportLoading, setSafeReportLoading] = useState(false);
  const [safeReportError, setSafeReportError] = useState<string>();
  const [recoveryAction, setRecoveryAction] = useState<RecoveryAction>();
  const [recoveryError, setRecoveryError] = useState<string>();
  const [reconcileConfirmationOpen, setReconcileConfirmationOpen] = useState(false);
  const [closingTransaction, setClosingTransaction] = useState(false);
  const [demoWallet, setDemoWallet] = useState<RequesterDemoWallet>();
  const [demoStarting, setDemoStarting] = useState(false);
  const [demoResetting, setDemoResetting] = useState(false);
  const [demoError, setDemoError] = useState<string>();
  const [demoUnavailable, setDemoUnavailable] = useState(false);
  const submissionRef = useRef<RequesterTransactionSubmission | undefined>(undefined);
  const submitInFlightRef = useRef<Promise<unknown> | undefined>(undefined);
  const activeTransactionRef = useRef<string | undefined>(undefined);
  const recoveryInFlightRef = useRef(false);
  const resetIdempotencyRef = useRef<string | undefined>(undefined);
  const demoRefreshVersionRef = useRef(0);
  const authoritativeStatusFocusedRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const statusRegionRef = useRef<HTMLElement>(null);
  const reconcileTriggerRef = useRef<HTMLButtonElement>(null);
  const reconcileCancelRef = useRef<HTMLButtonElement>(null);
  const reconcileConfirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!sessionChecking) headingRef.current?.focus();
  }, [screen, sessionChecking]);

  useEffect(() => {
    if (screen !== "status") {
      authoritativeStatusFocusedRef.current = false;
      return;
    }
    if (status && !authoritativeStatusFocusedRef.current) {
      headingRef.current?.focus();
      authoritativeStatusFocusedRef.current = true;
    }
  }, [screen, status]);

  useEffect(() => {
    let cancelled = false;
    void client.currentTransaction().then(({ transactionId: recoveredId }) => {
      if (cancelled || !recoveredId) return;
      activeTransactionRef.current = recoveredId;
      setTransactionId(recoveredId);
      setStatus(undefined);
      setPrivateResult(undefined);
      setSafeReport(undefined);
      setScreen("status");
    }).catch((error: unknown) => {
      if (!cancelled) setSessionError(redactedUiError(error));
    }).finally(() => {
      if (!cancelled) setSessionChecking(false);
    });
    return () => { cancelled = true; };
  }, [client]);

  const refreshDemoWallet = useCallback(async (): Promise<void> => {
    const refreshVersion = ++demoRefreshVersionRef.current;
    try {
      const wallet = await client.demoWallet();
      if (refreshVersion !== demoRefreshVersionRef.current) return;
      setDemoWallet(wallet);
      setDemoError(undefined);
      setDemoUnavailable(false);
    } catch (error) {
      if (refreshVersion !== demoRefreshVersionRef.current) return;
      if (error instanceof RequesterApiClientError) {
        setDemoWallet(undefined);
        setDemoUnavailable(true);
        setDemoError(undefined);
      } else {
        setDemoError(redactedUiError(error));
      }
    }
  }, [client]);

  useEffect(() => {
    if (sessionChecking) return;
    let cancelled = false;
    void refreshDemoWallet().then(() => {
      if (cancelled) return;
    });
    return () => { cancelled = true; };
  }, [refreshDemoWallet, sessionChecking]);

  useEffect(() => {
    if (reconcileConfirmationOpen) reconcileCancelRef.current?.focus();
  }, [reconcileConfirmationOpen]);

  useEffect(() => {
    if (!transactionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      setPolling(true);
      try {
        const authoritative = await client.status(transactionId);
        if (cancelled) return;
        setStatus(authoritative);
        setStatusError(undefined);
        void refreshDemoWallet();
        if (authoritative.operationalState === "active") {
          timer = setTimeout(() => { void refresh(); }, pollIntervalMs);
        }
      } catch (error) {
        if (cancelled) return;
        setStatusError(redactedUiError(error));
        if (!(error instanceof RequesterApiClientError) || error.detail.code !== "transaction_not_found") {
          timer = setTimeout(() => { void refresh(); }, pollIntervalMs);
        }
      } finally {
        if (!cancelled) setPolling(false);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, pollIntervalMs, refreshDemoWallet, transactionId]);

  const invalidateLogicalSubmission = (): void => {
    submissionRef.current = undefined;
    setSubmissionError(undefined);
  };

  const clearPrivateDraft = (): void => {
    setDocument(undefined);
    setPrompt("");
    setBudget("500");
    setErrors({});
    invalidateLogicalSubmission();
  };

  const handleDocument = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    invalidateLogicalSubmission();
    setDocument(undefined);
    setErrors((current) => withoutFormError(current, "document"));
    const file = event.target.files?.[0];
    if (!file) return;
    setDocumentBusy(true);
    try {
      setDocument(await prepareRequesterDocument(file));
    } catch (error) {
      setErrors((current) => ({ ...current, document: documentError(error) }));
    } finally {
      setDocumentBusy(false);
    }
  };

  const validateForm = (): number | undefined => {
    const next: FormErrors = {};
    if (!document) next.document = "Choose a supported document.";
    const parsedBudget = parseWholeSatBudget(budget);
    if (parsedBudget === undefined) next.budget = "Enter a positive whole-sat budget.";
    if (!isPromptWithinLimit(prompt)) {
      next.prompt = `The private prompt must not exceed ${formatByteSize(REQUESTER_PROMPT_MAXIMUM_BYTES)}.`;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) {
      queueMicrotask(() => errorRef.current?.focus());
      return undefined;
    }
    return parsedBudget;
  };

  const handleReview = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const maximumBudgetSats = validateForm();
    if (maximumBudgetSats === undefined || !document) return;
    if (!submissionRef.current) {
      submissionRef.current = client.createSubmission({
        privateDocument: document.privateDocument,
        mediaType: document.mediaType,
        ...(prompt.length === 0 ? {} : { privatePrompt: prompt }),
        maximumBudgetSats,
      });
    }
    setScreen("review");
  };

  const handleSubmit = (): void => {
    if (!submissionRef.current || submitInFlightRef.current) return;
    setSubmitting(true);
    setSubmissionError(undefined);
    const request = submissionRef.current.submit();
    submitInFlightRef.current = request;
    void request.then(({ transactionId: acceptedId }) => {
      // Release every private input and the submission closure immediately
      // after the runtime has durably accepted the transaction.
      clearPrivateDraft();
      activeTransactionRef.current = acceptedId;
      setStatus(undefined);
      setStatusError(undefined);
      setPrivateResult(undefined);
      setPrivateResultError(undefined);
      setSafeReport(undefined);
      setSafeReportError(undefined);
      setTransactionId(acceptedId);
      setScreen("status");
      void refreshDemoWallet();
    }).catch((error: unknown) => {
      setSubmissionError(redactedUiError(error));
    }).finally(() => {
      submitInFlightRef.current = undefined;
      setSubmitting(false);
    });
  };

  const handlePrivateResult = async (): Promise<void> => {
    const id = transactionId;
    if (!id || !status?.resultAvailable || privateResultLoading || privateResult) return;
    setPrivateResultLoading(true);
    setPrivateResultError(undefined);
    try {
      const result = await client.privateResult(id);
      if (activeTransactionRef.current === id) setPrivateResult(result);
    } catch (error) {
      if (activeTransactionRef.current === id) setPrivateResultError(redactedUiError(error));
    } finally {
      if (activeTransactionRef.current === id) setPrivateResultLoading(false);
    }
  };

  const handleSafeReport = async (): Promise<void> => {
    const id = transactionId;
    if (!id || !status?.reportAvailable || safeReportLoading || safeReport) return;
    setSafeReportLoading(true);
    setSafeReportError(undefined);
    try {
      const report = await client.report(id);
      if (activeTransactionRef.current === id) setSafeReport(report);
    } catch (error) {
      if (activeTransactionRef.current === id) setSafeReportError(redactedUiError(error));
    } finally {
      if (activeTransactionRef.current === id) setSafeReportLoading(false);
    }
  };

  const runRecovery = async (action: RecoveryAction): Promise<void> => {
    const id = transactionId;
    if (
      !id ||
      !status?.availableActions[action] ||
      recoveryInFlightRef.current
    ) return;
    recoveryInFlightRef.current = true;
    setRecoveryAction(action);
    setRecoveryError(undefined);
    let operationReturned = false;
    try {
      if (action === "resume") await client.resume(id);
      else if (action === "reconcile") await client.reconcile(id);
      else await client.refund(id);
      operationReturned = true;
      const authoritative = await client.status(id);
      if (activeTransactionRef.current !== id) return;
      setStatus(authoritative);
      setStatusError(undefined);
      void refreshDemoWallet();
    } catch (error) {
      if (activeTransactionRef.current !== id) return;
      if (operationReturned) setStatusError(redactedUiError(error));
      else setRecoveryError(redactedUiError(error));
    } finally {
      recoveryInFlightRef.current = false;
      if (activeTransactionRef.current === id) {
        setRecoveryAction(undefined);
        queueMicrotask(() => statusRegionRef.current?.focus());
      }
    }
  };

  const cancelReconciliation = (): void => {
    setReconcileConfirmationOpen(false);
    queueMicrotask(() => reconcileTriggerRef.current?.focus());
  };

  const confirmReconciliation = (): void => {
    setReconcileConfirmationOpen(false);
    void runRecovery("reconcile");
  };

  const handleConfirmationKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelReconciliation();
      return;
    }
    if (event.key !== "Tab") return;
    const first = reconcileCancelRef.current;
    const last = reconcileConfirmRef.current;
    if (!first || !last) return;
    if (event.shiftKey && globalThis.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && globalThis.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const clearTransactionMemory = (): void => {
    activeTransactionRef.current = undefined;
    recoveryInFlightRef.current = false;
    clearPrivateDraft();
    setDocumentBusy(false);
    setSubmitting(false);
    setTransactionId(undefined);
    setStatus(undefined);
    setStatusError(undefined);
    setPolling(false);
    setPrivateResult(undefined);
    setPrivateResultLoading(false);
    setPrivateResultError(undefined);
    setSafeReport(undefined);
    setSafeReportLoading(false);
    setSafeReportError(undefined);
    setRecoveryAction(undefined);
    setRecoveryError(undefined);
    setReconcileConfirmationOpen(false);
    setScreen("landing");
  };

  const closeTransaction = async (): Promise<void> => {
    if (closingTransaction) return;
    setClosingTransaction(true);
    setRecoveryError(undefined);
    try {
      await client.closeCurrentTransaction();
      clearTransactionMemory();
      setSessionError(undefined);
      void refreshDemoWallet();
    } catch (error) {
      setRecoveryError(redactedUiError(error));
    } finally {
      setClosingTransaction(false);
    }
  };

  const handleStartDemo = async (): Promise<void> => {
    if (demoStarting) return;
    setDemoStarting(true);
    setDemoError(undefined);
    try {
      await client.startDemo();
      await refreshDemoWallet();
    } catch (error) {
      setDemoError(redactedUiError(error));
    } finally {
      setDemoStarting(false);
    }
  };

  const handleResetDemo = async (): Promise<void> => {
    if (demoResetting) return;
    if (!demoWallet?.started || !demoWallet.resetAvailable) return;
    setDemoResetting(true);
    setDemoError(undefined);
    try {
      resetIdempotencyRef.current ??= `demo-reset-${globalThis.crypto.randomUUID()}`;
      await client.resetDemo(resetIdempotencyRef.current);
      resetIdempotencyRef.current = undefined;
      await refreshDemoWallet();
    } catch (error) {
      setDemoError(redactedUiError(error));
    } finally {
      setDemoResetting(false);
    }
  };

  const promptCapacity = promptBytes(prompt);

  return (
    <main className="requesterApp">
      <ProtocolHeader />

      {sessionChecking ? (
        <section className="transactionWorkspace" aria-busy="true" aria-live="polite">
          <div className="waitingState">
            <p className="eyebrow dark">Requester session</p>
            <h1>Checking for an active transaction</h1>
            <p>Recovering only server-owned safe transaction state.</p>
          </div>
        </section>
      ) : null}

      {!sessionChecking && screen === "landing" ? (
        <section className="requesterHero" aria-labelledby="requester-heading">
          <div className="heroMain">
            <p className="eyebrow">Requester transaction console</p>
            <h1 id="requester-heading" ref={headingRef} tabIndex={-1}>
              Private work.<br /><em>Protocol-visible truth.</em>
            </h1>
            <p className="lede">
              Start a document-summary transaction across Nostr, Pontmore concepts, NIP-59 private
              transport, and configured Cashu test ecash.
            </p>
            {demoUnavailable ? (
              <button className="primaryAction" type="button" onClick={() => setScreen("form")}>
                New transaction
              </button>
            ) : demoWallet?.started ? (
              <div className="demoWalletPanel" aria-labelledby="demo-wallet-heading">
                <p className="eyebrow dark">Demo Wallet</p>
                <h2 id="demo-wallet-heading">Demo balance: {demoWallet.balance?.availableSats ?? 0} demo sats</h2>
                <p className="demoDisclosure">Demo sats — no monetary value</p>
                <div className="demoActions">
                  <button className="primaryAction" type="button" onClick={() => setScreen("form")}>
                    New transaction
                  </button>
                  {demoWallet.resetAvailable ? (
                    <button
                      className="secondaryAction"
                      type="button"
                      disabled={demoResetting}
                      onClick={() => { void handleResetDemo(); }}
                    >
                      {demoResetting ? "Resetting…" : "Reset Demo"}
                    </button>
                  ) : (
                    <p className="demoResetBlocked">Finish or recover the current transaction before resetting this demo.</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="demoWalletPanel" aria-labelledby="demo-start-heading">
                <p className="eyebrow dark">Demo Wallet</p>
                <h2 id="demo-start-heading">Start a demo wallet</h2>
                <p className="demoDisclosure">Demo sats — no monetary value</p>
                <button
                  className="primaryAction"
                  type="button"
                  disabled={demoStarting}
                  onClick={() => { void handleStartDemo(); }}
                >
                  {demoStarting ? "Starting…" : "Start Demo"}
                </button>
              </div>
            )}
            {demoError ? <p className="resourceError" role="status">{demoError}</p> : null}
            {sessionError ? <p className="resourceError" role="status">{sessionError}</p> : null}
          </div>
          <ul className="protocolRail" aria-label="Integrated protocols">
            <li><strong>Nostr</strong><span>discovery and lifecycle</span></li>
            <li><strong>Pontmore</strong><span>provider and escrow references</span></li>
            <li><strong>NIP-59</strong><span>private task transport</span></li>
            <li><strong>Cashu</strong><span>configured test ecash</span></li>
          </ul>
        </section>
      ) : null}

      {screen === "form" ? (
        <section className="transactionWorkspace" aria-labelledby="new-transaction-heading">
          <div className="workspaceHeading">
            <p className="eyebrow dark">Step 1 of 2</p>
            <h1 id="new-transaction-heading" ref={headingRef} tabIndex={-1}>New transaction</h1>
            <p>Private inputs stay in memory and are sent only through the same-origin requester boundary.</p>
          </div>
          <form className="transactionForm" noValidate onSubmit={handleReview}>
            {Object.keys(errors).length > 0 ? (
              <div className="errorSummary" role="alert" tabIndex={-1} ref={errorRef}>
                <strong>Check the transaction details.</strong>
                <span>Correct the associated fields before continuing.</span>
              </div>
            ) : null}

            <fieldset>
              <legend>Private document</legend>
              <p id="document-description" className="fieldHelp">
                <code>text/plain</code> or <code>application/pdf</code>. Maximum original file size: {formatByteSize(REQUESTER_DOCUMENT_MAXIMUM_BYTES)}.
                PDF bytes are encoded for the existing API and are not parsed in the browser.
              </p>
              <label className="filePicker" htmlFor="request-document">
                <span>Choose document</span>
                <input
                  id="request-document"
                  name="document"
                  type="file"
                  accept="text/plain,application/pdf,.txt,.pdf"
                  aria-describedby={`document-description${errors.document ? " document-error" : ""}`}
                  aria-invalid={errors.document ? true : undefined}
                  onChange={(event) => { void handleDocument(event); }}
                />
              </label>
              {documentBusy ? <p className="fieldStatus" role="status">Reading the document in memory…</p> : null}
              {errors.document ? <p className="fieldError" id="document-error">{errors.document}</p> : null}
              {document ? (
                <dl className="fileMetadata" aria-label="Selected document metadata">
                  <div><dt>Filename</dt><dd>{document.filename}</dd></div>
                  <div><dt>Media type</dt><dd><code>{document.mediaType}</code></dd></div>
                  <div><dt>Size</dt><dd>{formatByteSize(document.size)}</dd></div>
                </dl>
              ) : null}
            </fieldset>

            <div className="fieldGroup">
              <label htmlFor="maximum-budget">Maximum budget</label>
              <div className="inputWithSuffix">
                <input
                  id="maximum-budget"
                  name="maximumBudgetSats"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  value={budget}
                  aria-describedby={`budget-description${errors.budget ? " budget-error" : ""}`}
                  aria-invalid={errors.budget ? true : undefined}
                  onChange={(event) => {
                    invalidateLogicalSubmission();
                    setBudget(event.target.value);
                    setErrors((current) => withoutFormError(current, "budget"));
                  }}
                />
                <span>sats</span>
              </div>
              <p id="budget-description" className="fieldHelp">Whole sats only. The runtime—not the browser—authorizes the signed offer.</p>
              {errors.budget ? <p className="fieldError" id="budget-error">{errors.budget}</p> : null}
            </div>

            <div className="fieldGroup">
              <label htmlFor="private-prompt">Private prompt <span>optional</span></label>
              <textarea
                id="private-prompt"
                name="privatePrompt"
                rows={5}
                value={prompt}
                aria-describedby={`prompt-description prompt-capacity${errors.prompt ? " prompt-error" : ""}`}
                aria-invalid={errors.prompt ? true : undefined}
                onChange={(event) => {
                  invalidateLogicalSubmission();
                  setPrompt(event.target.value);
                  setErrors((current) => withoutFormError(current, "prompt"));
                }}
              />
              <div className="fieldHelp capacityLine">
                <span id="prompt-description">Sent as a bounded private transaction input.</span>
                <span id="prompt-capacity" aria-live="polite">
                  {promptCapacity.toLocaleString("en-US")} / {REQUESTER_PROMPT_MAXIMUM_BYTES.toLocaleString("en-US")} bytes
                </span>
              </div>
              {errors.prompt ? <p className="fieldError" id="prompt-error">{errors.prompt}</p> : null}
            </div>

            <div className="formActions">
              <button className="secondaryAction" type="button" onClick={() => {
                clearPrivateDraft();
                setScreen("landing");
              }}>Cancel</button>
              <button className="primaryAction compact" type="submit" disabled={documentBusy}>Review request</button>
            </div>
          </form>
        </section>
      ) : null}

      {screen === "review" && document ? (
        <section className="transactionWorkspace" aria-labelledby="review-heading">
          <div className="workspaceHeading">
            <p className="eyebrow dark">Step 2 of 2</p>
            <h1 id="review-heading" ref={headingRef} tabIndex={-1}>Review transaction</h1>
            <p>Confirm safe request metadata before beginning an economic workflow.</p>
          </div>
          <div className="reviewCard">
            <dl className="reviewMetadata">
              <div><dt>Filename</dt><dd>{document.filename}</dd></div>
              <div><dt>Media type</dt><dd><code>{document.mediaType}</code></dd></div>
              <div><dt>Document size</dt><dd>{formatByteSize(document.size)}</dd></div>
              <div><dt>Maximum budget</dt><dd>{budget} sats</dd></div>
              <div><dt>Private prompt</dt><dd>{prompt.length > 0 ? "Present" : "Not provided"}</dd></div>
            </dl>
            <div className="privacyDisclosure">
              <strong>Private inputs are not previewed here.</strong>
              <p>
                The source document and optional prompt are private transaction inputs. This integrated
                PoC uses configured test ecash, and submission may begin an economic workflow against the
                configured test mint. It does not support real sats.
              </p>
            </div>
            {submissionError ? (
              <div className="errorSummary" role="alert">
                <strong>Submission was not accepted.</strong><span>{submissionError} You may retry the same logical submission.</span>
              </div>
            ) : null}
            <div className="formActions" aria-busy={submitting}>
              <button className="secondaryAction" type="button" disabled={submitting} onClick={() => setScreen("form")}>Back</button>
              <button className="primaryAction compact" type="button" disabled={submitting} onClick={handleSubmit}>
                {submitting ? "Submitting…" : submissionError ? "Retry transaction" : "Submit transaction"}
              </button>
            </div>
            <p className="srOnly" role="status" aria-live="polite">
              {submitting ? "Submitting the transaction to the authoritative runtime." : submissionError ?? ""}
            </p>
          </div>
        </section>
      ) : null}

      {screen === "status" ? (
        <section
          className="transactionWorkspace statusWorkspace"
          aria-busy={polling || recoveryAction !== undefined}
          ref={statusRegionRef}
          tabIndex={-1}
        >
          {status ? (
            <>
              <TransactionStatusView status={status} headingRef={headingRef} />
              <section className="recoveryPanel" aria-labelledby="recovery-heading">
                <div>
                  <p className="sectionKicker">Runtime-controlled recovery</p>
                  <h2 id="recovery-heading">Available actions</h2>
                  <p>
                    Actions appear only when authorized by the current status projection. They do not
                    optimistically change the displayed lifecycle.
                  </p>
                </div>
                <div className="recoveryActions">
                  {status.availableActions.resume ? (
                    <button
                      className="secondaryAction"
                      type="button"
                      disabled={recoveryAction !== undefined}
                      onClick={() => { void runRecovery("resume"); }}
                    >
                      {recoveryAction === "resume" ? "Resuming…" : "Resume"}
                    </button>
                  ) : null}
                  {status.availableActions.reconcile ? (
                    <button
                      className="primaryAction compact"
                      type="button"
                      disabled={recoveryAction !== undefined}
                      ref={reconcileTriggerRef}
                      onClick={() => setReconcileConfirmationOpen(true)}
                    >
                      {recoveryAction === "reconcile" ? "Reconciling…" : "Reconcile"}
                    </button>
                  ) : null}
                  {status.availableActions.refund ? (
                    <button
                      className="primaryAction compact"
                      type="button"
                      disabled={recoveryAction !== undefined}
                      onClick={() => { void runRecovery("refund"); }}
                    >
                      {recoveryAction === "refund" ? "Refunding…" : "Refund demo escrow"}
                    </button>
                  ) : null}
                  {!status.availableActions.resume && !status.availableActions.reconcile && !status.availableActions.refund ? (
                    <p>No runtime-controlled recovery action is currently available.</p>
                  ) : null}
                </div>
                {recoveryError ? <p className="resourceError" role="alert">{recoveryError}</p> : null}
                <p className="srOnly" role="status" aria-live="polite">
                  {recoveryAction ? `${recoveryAction} request is in progress.` : recoveryError ?? ""}
                </p>
              </section>
              <div className="terminalResources">
                <PrivateResultPanel
                  available={status.resultAvailable}
                  result={privateResult}
                  loading={privateResultLoading}
                  error={privateResultError}
                  onLoad={() => { void handlePrivateResult(); }}
                />
                <SafeReportPanel
                  available={status.reportAvailable}
                  report={safeReport}
                  loading={safeReportLoading}
                  error={safeReportError}
                  onLoad={() => { void handleSafeReport(); }}
                />
              </div>
            </>
          ) : (
            <div className="waitingState">
              <p className="eyebrow dark">Authoritative runtime status</p>
              <h1 ref={headingRef} tabIndex={-1}>Transaction accepted</h1>
              <p><span>Transaction ID</span><code>{transactionId}</code></p>
              <p>{statusError ?? "Waiting for the first status projection from the runtime…"}</p>
            </div>
          )}
          {status && statusError ? <div className="statusFetchError" role="status">{statusError} The last authoritative state remains displayed.</div> : null}
          {polling ? <p className="pollingStatus" role="status">Checking authoritative runtime state…</p> : null}
          <div className="closeTransactionPanel">
            <p>Closing clears server-side reload recovery and removes transaction-specific data from browser memory. It does not alter the runtime transaction.</p>
            <button
              className="secondaryAction"
              type="button"
              disabled={closingTransaction}
              onClick={() => { void closeTransaction(); }}
            >
              {closingTransaction ? "Closing transaction…" : "Close transaction"}
            </button>
          </div>
          <p className="srOnly" role="status" aria-live="polite">
            {status ? `Authoritative status updated: phase ${status.phase}; operational state ${status.operationalState}.` : ""}
          </p>
        </section>
      ) : null}

      {reconcileConfirmationOpen ? (
        <div className="confirmationBackdrop">
          <div
            className="confirmationDialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="reconcile-confirmation-heading"
            aria-describedby="reconcile-confirmation-description"
            onKeyDown={handleConfirmationKeyDown}
          >
            <p className="sectionKicker">Explicit confirmation required</p>
            <h2 id="reconcile-confirmation-heading">Inspect existing transaction state?</h2>
            <p id="reconcile-confirmation-description">
              PactAgent will inspect existing runtime and economic state to determine the authoritative
              outcome. The browser will not submit an economic operation. The outcome may remain unresolved.
            </p>
            <div className="confirmationActions">
              <button
                className="secondaryAction"
                type="button"
                ref={reconcileCancelRef}
                onClick={cancelReconciliation}
              >
                Cancel
              </button>
              <button
                className="primaryAction compact"
                type="button"
                ref={reconcileConfirmRef}
                onClick={confirmReconciliation}
              >
                Confirm reconciliation
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <TrustBoundary privateResultLoaded={privateResult !== undefined} />

      <footer>
        <span>PactAgent requester PoC</span>
        <span>Nostr · Pontmore · NIP-59 · Cashu test ecash</span>
      </footer>
    </main>
  );
}
