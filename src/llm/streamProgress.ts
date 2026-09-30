import { isPageSuspended } from '@/lib/pageLiveness';
import { useProgressStore } from '@/lib/progress';
import type { ChatFallback, ChatStreamActivity } from '@/llm/openrouter';
import { fallbackReasonWords } from '@/llm/openrouterErrors';

/**
 * THE ONE way a streamed model call shows its life in the progress dock
 * (00-OVERVIEW: multi-minute work must never look like a hang; docs/17 row
 * 412). Lifted out of `llm/moduleGen` so the module passes AND the canvas chat
 * (its reply, its follow-up and the adversarial review's two calls) render the
 * SAME phases with the SAME words — a second reporter would drift.
 *
 * The reporter feeds a stream's `onToken`/`onActivity` events (and, when the
 * caller wires it, `onFallback`) into the dock job's detail line. It throttles
 * to ~3/s (deltas arrive in bursts) and renders what the model is doing right
 * now — reasoning deltas never reach `onToken`, so a thinking model would
 * otherwise look frozen for minutes.
 *
 * PAUSED is named, never hidden: the stream watchdog's clock deliberately
 * credits time the page spent FROZEN (`lib/pageLiveness`), so while the
 * browser has frozen this tab the limits do not advance. A merely HIDDEN tab
 * no longer pauses them (docs/17 row 415 — the owner's remote screen can
 * report a tab he is looking at as hidden, and a dead call then hung).
 */
export interface StreamDetailReporter {
  onToken: (delta: string) => void;
  onActivity: (activity: ChatStreamActivity) => void;
  /** The chain switched to the fallback model: named on the entry at once,
   * and every later detail names the model now answering. */
  onFallback: (info: ChatFallback) => void;
}

/** The paused wording — exported so the pins read the one literal. */
export const STREAM_PAUSED_DETAIL =
  'paused — the browser froze this tab; time limits resume when it runs again';

export function streamDetailReporter(jobId: string, baseDetail: string): StreamDetailReporter {
  let base = baseDetail;
  let chars = 0;
  let lastAt = 0;
  const write = (detail: string): void => {
    useProgressStore.getState().update(jobId, { detail });
  };
  const report = (detail: string): void => {
    const now = Date.now();
    if (now - lastAt < 400) return;
    lastAt = now;
    write(detail);
  };
  return {
    onToken: (delta) => {
      chars += delta.length;
      report(`${base} — ${String(chars)} chars received`);
    },
    onActivity: (activity: ChatStreamActivity) => {
      const seconds = Math.round(activity.elapsedMs / 1000);
      if (isPageSuspended()) {
        report(`${base} — ${STREAM_PAUSED_DETAIL} (${String(seconds)}s of active time so far).`);
        return;
      }
      if (activity.phase === 'thinking') {
        // Set the expectation explicitly: reasoning models routinely think
        // for minutes on design-sized prompts — without this users read the
        // quiet dock as a hang and kill the run mid-think.
        report(
          `${base} — the model is thinking (${String(seconds)}s). ` +
            'Big design asks routinely take several minutes of thinking before the first words arrive — this is normal, not a hang.',
        );
      } else if (activity.phase === 'waiting' && seconds >= 5) {
        report(
          `${base} — no answer yet (${String(seconds)}s). ` +
            'The request may be queued at the provider; the first bytes can take minutes.',
        );
      }
    },
    onFallback: (info) => {
      // The restarted stream counts from zero (openrouter's onReset contract).
      chars = 0;
      base = `${base} → fallback ${info.to}`;
      lastAt = Date.now();
      write(`${base} — ${info.from} ${fallbackReasonWords(info.reason)}; retrying on the fallback model ${info.to}…`);
    },
  };
}

/**
 * A call is about to start on an EXISTING dock job: names it on the entry
 * ("<base> — waiting for the first bytes…") and returns its reporter. The
 * adversarial review uses this on its one "Reviewing «X»" entry, so the entry
 * says which of its two calls (critique, edit) is running and on which model.
 */
export function startStreamDetail(jobId: string, baseDetail: string): StreamDetailReporter {
  useProgressStore.getState().update(jobId, { detail: `${baseDetail} — waiting for the first bytes…` });
  return streamDetailReporter(jobId, baseDetail);
}

/**
 * One dock ENTRY for one streamed call: started before the call, finished when
 * it settles (success, failure or abort — `finally`). The entry is the dock's
 * view only: a failure still propagates to the caller's own loud path (toast /
 * failed message), never ends here.
 */
export async function withStreamProgress<T>(
  entry: { jobId: string; label: string; model: string },
  run: (reporter: StreamDetailReporter) => Promise<T>,
): Promise<T> {
  const progress = useProgressStore.getState();
  progress.start(entry.jobId, entry.label);
  try {
    return await run(startStreamDetail(entry.jobId, streamCallBase(entry.model)));
  } finally {
    progress.finish(entry.jobId);
  }
}

/** The base detail of a call entry: the model serving it. */
export function streamCallBase(model: string): string {
  return `Model: ${model}`;
}
