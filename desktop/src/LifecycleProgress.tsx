import type { ReactNode } from "react";
import { leftSaid } from "./journey";
import { formatElapsed } from "./SetupProgress";

/** One active status for Start and Quit; the step history is an explicit disclosure. */
export function LifecycleProgress({
  said,
  fraction,
  left,
  elapsed,
  bytes,
  details,
}: {
  said: string;
  fraction: number;
  left: number | null;
  elapsed: number;
  bytes?: string | null;
  details?: ReactNode;
}) {
  return (
    <section className="journey" aria-label="How far along">
      <div className="journey-head">
        <span className="step-spinner" aria-hidden="true" />
        <span className="journey-said" aria-live="polite" aria-atomic="true">
          {said}
        </span>
        <span className="journey-time">
          {leftSaid(left)}
          {bytes && <span className="journey-bytes">{` · ${bytes}`}</span>}
          <span aria-hidden="true">{` · ${formatElapsed(elapsed)} so far`}</span>
        </span>
      </div>
      <progress
        aria-label="How far along"
        aria-valuetext={`${Math.round(fraction * 100)}%, ${leftSaid(left)}`}
        value={fraction}
        max={1}
      />
      {details && (
        <details className="lifecycle-details">
          <summary>Details</summary>
          {details}
        </details>
      )}
    </section>
  );
}
