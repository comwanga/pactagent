"use client";

import type { RuntimePhase } from "@/lib/pactagent-api-client";

const SUCCESS_PATH: readonly RuntimePhase[] = [
  "initialized",
  "proposed",
  "accepted",
  "escrow_funded",
  "task_delivered",
  "result_submitted",
  "result_verified",
  "release_authorized",
  "settled",
];

const REFUND_PATH: readonly RuntimePhase[] = [
  "initialized",
  "proposed",
  "accepted",
  "refund_authorized",
  "refunded",
];

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

const PHASE_VERBS: Record<RuntimePhase, string> = {
  initialized: "Preparing private terms",
  proposed: "Discovering provider (P002) over Nostr",
  accepted: "Provider accepted the pact",
  escrow_funded: "Funding Cashu escrow (PIP-01)",
  task_delivered: "Delivering private task (NIP-59)",
  result_submitted: "Provider submitted the result",
  result_verified: "Verifying result against commitment",
  release_authorized: "Authorizing escrow release",
  settled: "Settled — pact complete",
  refund_authorized: "Authorizing refund",
  refunded: "Refunded — pact cancelled",
};

export function LifecycleStepper({
  phase,
  kind,
}: {
  phase: RuntimePhase;
  kind: "successful" | "refund";
}): React.ReactElement {
  const path = kind === "refund" ? REFUND_PATH : SUCCESS_PATH;
  const currentIndex = path.indexOf(phase);
  const isTerminal = phase === "settled" || phase === "refunded";

  return (
    <ol className="stepper" aria-label="Agent lifecycle">
      {path.map((step, index) => {
        const isDone = index < currentIndex || isTerminal;
        const isCurrent = index === currentIndex && !isTerminal;
        const stateClass = isDone ? "done" : isCurrent ? "current" : "pending";
        return (
          <li
            key={step}
            className={`stepperItem ${stateClass}`}
            aria-current={isCurrent ? "step" : undefined}
          >
            <span className="stepperDot" aria-hidden="true">
              {isDone ? "✓" : index + 1}
            </span>
            <span className="stepperLabel">{PHASE_LABELS[step]}</span>
            {isCurrent && (
              <span className="stepperVerb" aria-live="polite">
                {PHASE_VERBS[step]}…
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
