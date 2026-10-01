"use client";

import { useEffect, useRef } from "react";

import type { RuntimePhase } from "@/lib/pactagent-api-client";

import { PHASE_VERBS_PAST } from "./phase-labels";

export interface ActivityEntry {
  readonly id: string;
  readonly phase: RuntimePhase;
  readonly timestamp: number;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatRelative(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 1_000) return "just now";
  const seconds = Math.round(delta / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
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
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [entries]);

  return (
    <div className="activityPanel">
      <div className="activityHeader">
        <h3>Agent activity</h3>
        <span className={`pollIndicator ${polling ? "polling" : "idle"}`}>
          <span className="pollDot" aria-hidden="true" />
          {polling ? "Live" : "Idle"}
          {lastUpdatedMs !== undefined ? ` · ${formatRelative(lastUpdatedMs)}` : ""}
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="activityEmpty">Waiting for the agent to start…</p>
      ) : (
        <ul className="activityList">
          {entries.map((entry) => (
            <li key={entry.id} className="activityItem">
              <time className="activityTime">{formatTime(entry.timestamp)}</time>
              <span className="activityArrow" aria-hidden="true">→</span>
              <span className="activityText">{PHASE_VERBS_PAST[entry.phase]}</span>
            </li>
          ))}
          <div ref={endRef} />
        </ul>
      )}
    </div>
  );
}
