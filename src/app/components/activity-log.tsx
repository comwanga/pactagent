"use client";

import { useEffect, useRef } from "react";

import type { RuntimePhase } from "@/lib/pactagent-api-client";

const PHASE_VERBS: Record<RuntimePhase, string> = {
  initialized: "Prepared private terms",
  proposed: "Discovered provider (P002) over Nostr",
  accepted: "Provider accepted the pact",
  escrow_funded: "Funded Cashu escrow (PIP-01)",
  task_delivered: "Delivered private task (NIP-59)",
  result_submitted: "Provider submitted the result",
  result_verified: "Verified result against commitment",
  release_authorized: "Authorized escrow release",
  settled: "Settled — pact complete",
  refund_authorized: "Authorized refund",
  refunded: "Refunded — pact cancelled",
};

export interface ActivityEntry {
  readonly id: string;
  readonly phase: RuntimePhase;
  readonly timestamp: number;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ActivityLog({
  entries,
  polling,
  lastUpdatedMs,
}: {
  entries: readonly ActivityEntry[];
  polling: boolean;
  lastUpdatedMs?: number;
}): React.ReactElement {
  const endRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [entries.length]);

  return (
    <section className="activityLog" aria-labelledby="activity-heading">
      <div className="activityHeader">
        <h3 id="activity-heading">Agent activity</h3>
        <span className={`pollIndicator ${polling ? "polling" : "idle"}`} aria-live="polite">
          <span className="pollDot" aria-hidden="true" />
          {polling ? "Live" : "Idle"}
          {lastUpdatedMs !== undefined ? ` · updated ${formatRelative(lastUpdatedMs)}` : ""}
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="activityEmpty">Waiting for the agent to start…</p>
      ) : (
        <ol className="activityList">
          {entries.map((entry) => (
            <li key={entry.id} className="activityItem">
              <time className="activityTime">{formatTime(entry.timestamp)}</time>
              <span className="activityArrow" aria-hidden="true">→</span>
              <span className="activityText">{PHASE_VERBS[entry.phase]}</span>
            </li>
          ))}
          <li ref={endRef} aria-hidden="true" className="activityEnd" />
        </ol>
      )}
    </section>
  );
}

function formatRelative(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 1_000) return "just now";
  const seconds = Math.round(delta / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}
