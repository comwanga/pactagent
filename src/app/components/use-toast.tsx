"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: "success" | "error" | "info";
}

export interface UseToast {
  readonly toasts: readonly Toast[];
  readonly push: (message: string, tone?: Toast["tone"]) => void;
  readonly dismiss: (id: number) => void;
}

const AUTO_DISMISS_MS = 4_000;

export function useToast(): UseToast {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const idRef = useRef(0);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(
    () => () => {
      for (const timer of timersRef.current) clearTimeout(timer);
      timersRef.current.clear();
    },
    [],
  );

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (message: string, tone: Toast["tone"] = "info") => {
      const id = ++idRef.current;
      setToasts((current) => [...current, { id, message, tone }]);
      const timer = setTimeout(() => {
        dismiss(id);
        timersRef.current.delete(timer);
      }, AUTO_DISMISS_MS);
      timersRef.current.add(timer);
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}

export function ToastViewport({ toasts, dismiss }: UseToast): React.ReactElement {
  return (
    <div className="toastViewport" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast ${toast.tone}`}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          <span>{toast.message}</span>
          <button
            type="button"
            className="toastDismiss"
            aria-label="Dismiss notification"
            onClick={() => dismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
