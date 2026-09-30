"use client";

import { useState } from "react";

import {
  type PrivateResult,
  type TransactionStatus,
  type WorkflowReport,
} from "@/lib/pactagent-api-client";

import { ActivityLog, type ActivityEntry } from "./activity-log";
import { CopyButton } from "./copy-button";
import { LifecycleStepper } from "./lifecycle-stepper";
import { PHASE_LABELS } from "./phase-labels";

export function TransactionDetail({
  status,
  report,
  privateResult,
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
}): React.ReactElement {
  const offer = status.selectedOffer;
  const [reconcileConfirming, setReconcileConfirming] = useState(false);

  const stateClass = status.operationalState;

  return (
    <div className="txnView">
      <div className="txnHeader">
        <span className="txnId">{status.transactionId.slice(0, 20)}…</span>
        <span className={`stateBadge`}>
          <span className={`dot ${stateClass}`} aria-hidden="true" />
          <span aria-live="polite">{status.operationalState.replace(/_/g, " ")}</span>
        </span>
        <button type="button" className="newTxnBtn" onClick={onClose}>
          New transaction
        </button>
      </div>

      <div className="txnBody">
        <div className="txnLeft">
          <LifecycleStepper phase={status.phase} kind={status.kind} />
          <ActivityLog entries={activity} polling={polling} lastUpdatedMs={lastUpdatedMs} />
        </div>

        <div className="txnRight">
          {error && <div className="errorBanner">{error}</div>}
          {status.failureCode && (
            <div className="errorBanner">Transaction failed: {status.failureCode.replace(/_/g, " ")}</div>
          )}

          <div className="detailSection">
            <h3>Agreement</h3>
            <div className="detailGrid">
              <div>
                <dt>Agreement ID</dt>
                <dd><code>{status.agreementId.slice(0, 12)}…</code><CopyButton value={status.agreementId} label="Copy" /></dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>{offer.amountSats} {offer.unit}</dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd><code>{offer.providerPublicKey.slice(0, 16)}…</code></dd>
              </div>
              <div>
                <dt>Phase</dt>
                <dd>{PHASE_LABELS[status.phase] ?? status.phase}</dd>
              </div>
            </div>
          </div>

          {status.requesterDecision && (
            <div className="decisionPanel">
              <span className="decisionHead">Requester decision · {status.requesterDecision.source}</span>
              <div className="decisionBody">
                <strong>{status.requesterDecision.authorized ? "Approved" : "Rejected"}</strong>
                {" — "}provider {status.requesterDecision.recommendation.providerPublicKey.slice(0, 12)}… / {status.requesterDecision.recommendation.amountSats} sats
              </div>
              <ul className="policyChecks">
                {Object.entries(status.requesterDecision.policy).map(([key, passed]) => (
                  <li key={key}>
                    <span className={passed ? "check" : "uncheck"} aria-hidden="true">{passed ? "✓" : "✗"}</span>
                    {key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).toLowerCase()}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(status.availableActions.resume || status.availableActions.reconcile || status.resultAvailable || status.reportAvailable) && (
            <div className="detailSection">
              <h3>Actions</h3>
              <div className="actionRow">
                {status.availableActions.resume && (
                  <button type="button" onClick={onResume} disabled={actionInFlight} className="actionBtn primary">
                    Resume
                  </button>
                )}
                {status.availableActions.reconcile && !reconcileConfirming && (
                  <button type="button" onClick={() => setReconcileConfirming(true)} disabled={actionInFlight} className="reconcileBtn">
                    Reconcile…
                  </button>
                )}
                {status.availableActions.reconcile && reconcileConfirming && (
                  <span className="confirmRow">
                    <button type="button" onClick={() => { setReconcileConfirming(false); onReconcile(); }} disabled={actionInFlight} className="confirmBtn">
                      Confirm reconcile
                    </button>
                    <button type="button" onClick={() => setReconcileConfirming(false)} disabled={actionInFlight} className="cancelBtn">
                      Cancel
                    </button>
                  </span>
                )}
                {status.reportAvailable && !report && (
                  <button type="button" onClick={onFetchReport} disabled={actionInFlight} className="actionBtn secondary">
                    Fetch report
                  </button>
                )}
                {status.resultAvailable && (
                  <button type="button" onClick={onFetchResult} disabled={actionInFlight} className="actionBtn primary">
                    {privateResult ? "Refresh summary" : "Retrieve summary"}
                  </button>
                )}
              </div>
            </div>
          )}

          {privateResult && (
            <div className="resultPanel">
              <h3>Private summary</h3>
              <div className="resultContent">
                <pre>{privateResult.summary}</pre>
              </div>
            </div>
          )}

          {report && (
            <div className="detailSection">
              <h3>Safe report</h3>
              <div className="detailGrid">
                <div><dt>Outcome</dt><dd>{report.finalOutcome}</dd></div>
                <div><dt>Amount</dt><dd>{report.amountSats} {report.unit}</dd></div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
