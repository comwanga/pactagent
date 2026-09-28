"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useCopy(): {
  readonly copied: boolean;
  readonly copy: (value: string) => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(
    async (value: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1_500);
      } catch {
        // Clipboard unavailable (insecure context); fail silently.
      }
    },
    [],
  );

  return { copied, copy };
}

export function CopyButton({
  value,
  label = "Copy",
  onCopied,
}: {
  value: string;
  label?: string;
  onCopied?: () => void;
}): React.ReactElement {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      className={`copyButton ${copied ? "copied" : ""}`}
      onClick={async () => {
        await copy(value);
        onCopied?.();
      }}
      aria-label={`${label}: ${value}`}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
