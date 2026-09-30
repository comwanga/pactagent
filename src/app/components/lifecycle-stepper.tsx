"use client";

import type { RuntimePhase } from "@/lib/pactagent-api-client";

import { PHASE_LABELS } from "./phase-labels";

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

export function LifecycleStepper({
  phase,
  kind,
}: {
  phase: RuntimePhase;
  kind: "successful" | "refund";
}): React.ReactElement {
  const path = kind === "refund" ? REFUND_PATH : SUCCESS_PATH;
  const currentIndex = Math.max(0, path.indexOf(phase));
  const isTerminal = phase === "settled" || phase === "refunded";

  return (
    <div className="stepper" aria-label="Agent lifecycle">
      {path.map((step, index) => {
        const isDone = index < currentIndex || isTerminal;
        const isCurrent = index === currentIndex && !isTerminal;
        const stateClass = isDone ? "done" : isCurrent ? "current" : "";
        return (
          <div key={step} className={`stepItem ${stateClass}`}>
            <span className="stepDot" aria-hidden="true">
              {isDone ? "✓" : index + 1}
            </span>
            <span className="stepLabel">{PHASE_LABELS[step]}</span>
          </div>
        );
      })}
    </div>
  );
}
