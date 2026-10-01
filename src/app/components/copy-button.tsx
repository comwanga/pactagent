"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useCopy(): {
  readonly copied: boolean;
  readonly copyFailed: boolean;
  readonly copy: (value: string) => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(
    async (value: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(value);
        setCopyFailed(false);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1_500);
      } catch {
        setCopied(false);
        setCopyFailed(true);
      }
    },
    [],
  );

  return { copied, copyFailed, copy };
}

export function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}): React.ReactElement {
  const { copied, copyFailed, copy } = useCopy();
  return (
    <>
      <button
        type="button"
        className={`copyButton ${copied ? "copied" : ""}`}
        onClick={() => void copy(value)}
        aria-label={`${label}: ${value}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      {copyFailed && (
        <span role="alert" className="copyErrorText">
          Copy failed
        </span>
      )}
    </>
  );
}
