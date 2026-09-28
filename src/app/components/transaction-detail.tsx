"use client";

import { useState } from "react";

import {
  type OperationalState,
  type PrivateResult,
  type RuntimePhase,
  type TransactionStatus,
  type WorkflowReport,
} from "@/lib/pactagent-api-client";

import { ActivityLog, type ActivityEntry } from "./activity-log";
import { CopyButton } from "./copy-button";
import { LifecycleStepper } from "./lifecycle-stepper";

const PHASE_LABELS: Record<RuntimePhase, string> = {
  initialized: "Initialized",
  proposed: "Proposed",
  accepted: "Accepted",
  escrow_funded: "Escrow funded",
  task_delivered: "Task delivered",
  result_submitted: "Result submitted",
  result_verified: "Result verified",
  release_authorized: "Release authorized",
  settled: "Settled",
  refund_authorized: "Refund authorized",
  refunded: "Refunded",
};

const STATE_CLASSES: Record<OperationalState, string> = {
  active: "active",
  failed: "failed",
  reconciliation_required: "reconciliation",
  resolved_not_funded: "warning",
  refunded: "refunded",
  settled: "settled",
};

export function TransactionDetail({
  status,
  report,
  privateResult,
  idempotencyKey,
  actionInFlight,
  polling,
  activity,
  lastUpdatedMs,
  error,
  onResume,
  onReconcile,
  onFetchReport,
  onFetchResult,
  onClose,
  onSignOut,
}: {
  status: TransactionStatus;
  report?: WorkflowReport;
  privateResult?: PrivateResult;
  idempotencyKey?: string;
  actionInFlight: boolean;
  polling: boolean;
  activity: readonly ActivityEntry[];
  lastUpdatedMs?: number;
  error?: string;
  onResume: () => void;
  onReconcile: () => void;
  onFetchReport: () => void;
  onFetchResult: () => void;
  onClose: () => void;
  onSignOut: () => void;
}): React.ReactElement {
  const stateClass = STATE_CLASSES[status.operationalState] ?? "active";
  const offer = status.selectedOffer;
  const terminal = status.finalOutcome === "settled" || status.finalOutcome === "refunded";
  const [reconcileConfirming, setReconcileConfirming] = useState(false);

  return (
    <>
      <section className="section txnStatusSection" aria-labelledby="txn-heading">
        <div className="sectionHeading">
          <div>
            <p className="eyebrow dark">
              Transaction <code>{status.transactionId.slice(0, 16)}</code>
              <CopyButton value={status.transactionId} label="Copy transaction id" />
            </p>
            <h2 id="txn-heading">{PHASE_LABELS[status.phase] ?? status.phase}</h2>
          </div>
          <div className="stateBadge">
            <span className={`dot ${stateClass}`} aria-hidden="true" />
            <span aria-live="polite" role="status">{status.operationalState.replace(/_/g, " ")}</span>
          </div>
        </div>

        {idempotencyKey && (
          <p className="idempotencyNote">
            Idempotency key: <code>{idempotencyKey.slice(0, 16)}…</code>
            <small> One key per logical request prevents duplicate agreements.</small>
          </p>
        )}

        <dl className="txnGrid">
          <div>
            <dt>Agreement ID</dt>
            <dd>
              <code>{status.agreementId.slice(0, 24)}…</code>
              <CopyButton value={status.agreementId} label="Copy agreement id" />
            </dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>
              <code>{offer.providerPublicKey.slice(0, 20)}…</code>
              <CopyButton value={offer.providerPublicKey} label="Copy provider key" />
            </dd>
          </div>
          <div><dt>Amount</dt><dd>{offer.amountSats} {offer.unit}</dd></div>
          <div><dt>Kind</dt><dd>{status.kind}</dd></div>
        </dl>

        <dl className="referenceGrid" aria-label="Selected provider references">
          <div><dt>Provider definition</dt><dd><code>{offer.providerDefinitionReference}</code></dd></div>
          <div><dt>Signed offer</dt><dd><code>{offer.offerReference}</code></dd></div>
          <div><dt>Cashu descriptor</dt><dd><code>{offer.escrowDescriptorReference}</code></dd></div>
        </dl>

        {status.agreementRootEventId && (
          <p className="refNote">
            Root event: <code>{status.agreementRootEventId.slice(0, 24)}…</code>
            <CopyButton value={status.agreementRootEventId} label="Copy root event" />
          </p>
        )}
        {status.escrowReference && (
          <p className="refNote">Escrow: <code>{status.escrowReference}</code><CopyButton value={status.escrowReference} label="Copy escrow ref" /></p>
        )}
        {status.settlementReference && (
          <p className="refNote">Settlement: <code>{status.settlementReference}</code><CopyButton value={status.settlementReference} label="Copy settlement ref" /></p>
        )}
        {status.refundReference && (
          <p className="refNote">Refund: <code>{status.refundReference}</code><CopyButton value={status.refundReference} label="Copy refund ref" /></p>
        )}

        {error && <p role="alert" className="errorText">{error}</p>}
        {status.failureCode && (
          <p role="alert" className="errorText">Transaction failed: {status.failureCode.replace(/_/g, " ")}</p>
        )}

        <div className="actionRow">
          {status.availableActions.resume && (
            <button onClick={onResume} disabled={actionInFlight} className="primaryBtn">
              Resume
            </button>
          )}
          {status.availableActions.reconcile && !reconcileConfirming && (
            <button
              onClick={() => setReconcileConfirming(true)}
              disabled={actionInFlight}
              className="reconcileBtn"
            >
              Reconcile…
            </button>
          )}
          {status.availableActions.reconcile && reconcileConfirming && (
            <span className="confirmRow" role="group" aria-label="Confirm reconciliation">
              <button
                onClick={() => {
                  setReconcileConfirming(false);
                  onReconcile();
                }}
                disabled={actionInFlight}
                className="reconcileBtn"
              >
                Confirm reconcile
              </button>
              <button
                onClick={() => setReconcileConfirming(false)}
                disabled={actionInFlight}
                className="closeBtn"
              >
                Cancel
              </button>
            </span>
          )}
          {status.reportAvailable && !report && (
            <button onClick={onFetchReport} disabled={actionInFlight}>
              Fetch safe report
            </button>
          )}
          {status.resultAvailable && !privateResult && (
            <button onClick={onFetchResult} disabled={actionInFlight} className="primaryBtn">
              Retrieve private summary
            </button>
          )}
          <button onClick={onClose} className="closeBtn">Start new transaction</button>
        </div>
      </section>

      <section className="section liveSection" aria-label="Live agent progress">
        <div className="sectionHeading">
          <div>
            <p className="eyebrow dark">Agent progress</p>
            <h2>{terminal ? "Lifecycle complete" : "Negotiating autonomously"}</h2>
          </div>
          <p className="sectionNote">
            The agent moves through each phase over Nostr and Cashu without human input.
          </p>
        </div>
        <LifecycleStepper phase={status.phase} kind={status.kind} />
        <ActivityLog entries={activity} polling={polling} lastUpdatedMs={lastUpdatedMs} />
      </section>

      {status.requesterDecision && <RequesterDecisionView decision={status.requesterDecision} offer={offer} />}
      <TrustBoundaryView status={status} />
      {report && <SafeReportView report={report} />}
      {privateResult && <PrivateResultView result={privateResult} />}

      <section className="section signOutSection" aria-label="Session">
        <button onClick={onSignOut} className="signOutBtn">Sign out (clear session)</button>
      </section>
    </>
  );
}

function RequesterDecisionView({
  decision,
  offer,
}: {
  decision: NonNullable<TransactionStatus["requesterDecision"]>;
  offer: NonNullable<TransactionStatus["selectedOffer"]>;
}): React.ReactElement {
  const checks: Array<{ label: string; passed: boolean }> = [
    { label: "Selected provider matches validated discovery", passed: decision.policy.selectedProviderMatchesDiscovery },
    { label: `Exact signed offer is ${offer.amountSats} sats`, passed: decision.policy.priceAllowed },
    { label: "Amount is within requester budget", passed: decision.policy.withinRequesterBudget },
    { label: "Cashu settlement is permitted", passed: decision.policy.cashuCompatible },
    { label: "Stable references match", passed: decision.policy.stableReferencesMatch },
    { label: "Execution duration is within policy", passed: decision.policy.executionDurationAllowed },
  ];

  return (
    <section className="section decisionSection" aria-labelledby="decision-heading">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow dark">Machine Money · Requester decision</p>
          <h2 id="decision-heading">Advisory model + deterministic policy</h2>
        </div>
        <p className="sectionNote">
          The model recommends; the deterministic policy authorizes. The model has no signing, Cashu, or settlement capability.
        </p>
      </div>
      <div className="decisionGrid">
        <article className="decisionCard">
          <p className="cardLabel">AI recommendation ({decision.source})</p>
          <strong>{decision.recommendation.providerPublicKey.slice(0, 16)}… / {decision.recommendation.amountSats} sats</strong>
          <code>{decision.recommendation.offerReference}</code>
          <span>Recommended</span>
          <small>Advisory only — no authority to sign, publish, or settle.</small>
        </article>
        <article className="decisionCard">
          <p className="cardLabel">Deterministic policy</p>
          <ul className="policyChecks">
            {checks.map((c) => (
              <li key={c.label}>
                <span className="check" aria-hidden="true">{c.passed ? "✓" : "✗"}</span>
                {c.label}
              </li>
            ))}
          </ul>
          <strong>Decision: {decision.authorized ? "approved" : "rejected"}</strong>
        </article>
      </div>
    </section>
  );
}

function TrustBoundaryView({ status }: { status: TransactionStatus }): React.ReactElement {
  return (
    <section className="section trustSection" aria-labelledby="trust-heading">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow dark">Trust boundary</p>
          <h2 id="trust-heading">Public lifecycle vs private payloads</h2>
        </div>
        <p className="sectionNote">
          The runtime exposes safe public references. Private material never enters public events, logs, or this view.
        </p>
      </div>
      <div className="trustGrid">
        <article className="trustCard safe">
          <p className="cardLabel">Safe / public-shaped</p>
          <ul>
            <li><span className="check" aria-hidden="true">✓</span> Provider identity and stable references</li>
            <li><span className="check" aria-hidden="true">✓</span> Signed offer amount ({status.selectedOffer.amountSats} sats)</li>
            <li><span className="check" aria-hidden="true">✓</span> Lifecycle state ({PHASE_LABELS[status.phase]})</li>
            {status.settlementReference && <li><span className="check" aria-hidden="true">✓</span> Settlement reference</li>}
            {status.refundReference && <li><span className="check" aria-hidden="true">✓</span> Refund reference</li>}
            {status.escrowReference && <li><span className="check" aria-hidden="true">✓</span> Opaque escrow reference</li>}
          </ul>
        </article>
        <article className="trustCard private">
          <p className="cardLabel">Private</p>
          <ul>
            <li><span className="lock" aria-hidden="true">🔒</span> Source document</li>
            <li><span className="lock" aria-hidden="true">🔒</span> Requester prompt</li>
            <li><span className="lock" aria-hidden="true">🔒</span> Complete summary</li>
            <li><span className="lock" aria-hidden="true">🔒</span> Cashu proofs and secrets</li>
            <li><span className="lock" aria-hidden="true">🔒</span> Signing and encryption keys</li>
            <li><span className="lock" aria-hidden="true">🔒</span> Terms-commitment salt</li>
          </ul>
        </article>
      </div>
    </section>
  );
}

function SafeReportView({ report }: { report: WorkflowReport }): React.ReactElement {
  return (
    <section className="section reportSection" aria-labelledby="report-heading">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow dark">Safe terminal report</p>
          <h2 id="report-heading">Canonical lifecycle</h2>
        </div>
        <p className="sectionNote">
          Allowlisted public data only. No private payloads merged into this report.
        </p>
      </div>
      <ol className="lifecycleList">
        {report.lifecycle.map((step, i) => (
          <li key={step.eventId}>
            <span className="stepNum">{i + 1}</span>
            <strong>{PHASE_LABELS[step.state] ?? step.state}</strong>
            <code>{step.eventId.slice(0, 24)}…</code>
          </li>
        ))}
      </ol>
      <dl className="reportGrid">
        <div><dt>Agreement</dt><dd><code>{report.agreementId.slice(0, 24)}…</code></dd></div>
        <div><dt>Requester</dt><dd><code>{report.requesterPublicKey.slice(0, 20)}…</code></dd></div>
        <div><dt>Provider</dt><dd><code>{report.providerPublicKey.slice(0, 20)}…</code></dd></div>
        <div><dt>Amount</dt><dd>{report.amountSats} {report.unit}</dd></div>
        <div><dt>Outcome</dt><dd>{report.finalOutcome}</dd></div>
        {report.settlementReference && <div><dt>Settlement</dt><dd><code>{report.settlementReference}</code></dd></div>}
        {report.refundReference && <div><dt>Refund</dt><dd><code>{report.refundReference}</code></dd></div>}
      </dl>
    </section>
  );
}

function PrivateResultView({ result }: { result: PrivateResult }): React.ReactElement {
  return (
    <section className="section resultSection" aria-labelledby="result-heading">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow dark">Private summary</p>
          <h2 id="result-heading">Complete result</h2>
        </div>
        <p className="sectionNote">
          Retrieved through the authorized private-result endpoint. This content is structurally separate from the safe report and is never placed in URLs, logs, or persisted storage.
        </p>
      </div>
      <div className="resultContent" role="region" aria-label="Private document summary">
        <pre>{result.summary}</pre>
      </div>
    </section>
  );
}
