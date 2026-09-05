import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type DiceBox from '@3d-dice/dice-box';
import type { DiceBoxRollDie } from '@3d-dice/dice-box';

import { toastError } from '@/lib/toast';

export type DiceEngineStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface DiceEngine {
  /** Engine lifecycle state surfaced to the picker UI. */
  status: DiceEngineStatus;
  /** Failure detail; rendered inline and toasted at failure time — never swallowed. */
  error: string | null;
  /** Attach to the always-mounted stage div the engine renders its canvas into. */
  stageRef: RefObject<HTMLDivElement>;
  /** Idempotently dynamic-import + init the engine (first dialog open). */
  ensureStarted: () => void;
  /** Reset a failed start and try again. */
  retry: () => void;
  /** Roll grouped notation; rejects on engine failure — the caller surfaces it. */
  rollDice: (notation: string[]) => Promise<DiceBoxRollDie[]>;
  /** Remove settled dice from the board (result-overlay dismissal). */
  clearDice: () => void;
}

interface DiceEngineOptions {
  /** Test seam: the init watchdog fires this many ms after start. */
  initTimeoutMs?: number;
}

const INIT_TIMEOUT_MS = 20_000;

let nextStageId = 0;

/**
 * `@3d-dice/dice-box` lifecycle for the dice roller (M5-D amendment): the
 * Babylon/Ammo engine is dynamic-imported on FIRST USE so the battle surface
 * never pays the bundle cost, initialized against an always-mounted stage
 * div, and failed loudly — an init failure or timeout sets the error state
 * (inline status + toast) and blocks dice rolls; it never degrades silently
 * to a non-3D roll. Flat modifier-only rolls bypass the engine entirely.
 *
 * Ported from GM_Helper's DiceRoller.tsx boot sequence, including the
 * `offscreen: false` workaround ("Offscreen workers often never finish init
 * under Vite") and the init watchdog race.
 */
export function useDiceEngine(options: DiceEngineOptions = {}): DiceEngine {
  const initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
  const [status, setStatus] = useState<DiceEngineStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<DiceBox | null>(null);
  const attemptRef = useRef(0);

  const fail = useCallback((message: string, cause: unknown): void => {
    boxRef.current = null;
    setStatus('error');
    setError(message);
    // Rule 2 (00-OVERVIEW): the inline status is one surface; the toast is
    // the guaranteed-visible one for a failure that can happen while the
    // picker is closed.
    toastError('3D dice failed to load', cause instanceof Error ? cause : new Error(message));
  }, []);

  const tearDown = useCallback((): void => {
    try {
      boxRef.current?.clear();
    } catch {
      // A half-initialized engine may refuse clear(); the canvases go below.
    }
    boxRef.current = null;
    const container = stageRef.current;
    if (container !== null) {
      for (const canvas of [...container.querySelectorAll('canvas')]) {
        canvas.remove();
      }
    }
  }, []);

  const start = useCallback((): void => {
    const attempt = attemptRef.current;
    const container = stageRef.current;
    if (container === null) {
      fail('Dice stage is not mounted', new Error('Dice stage is not mounted'));
      return;
    }
    setStatus('loading');
    setError(null);

    const boot = async (): Promise<void> => {
      // The whole Babylon/Ammo engine rides this one dynamic import.
      const { default: DiceBoxCtor } = await import('@3d-dice/dice-box');
      if (attemptRef.current !== attempt) {
        return;
      }
      const stageId = `dice-stage-${String(nextStageId++)}`;
      container.id = stageId;
      const canvasId = `dice-canvas-${crypto.randomUUID()}`;
      const instance = new DiceBoxCtor({
        id: canvasId,
        container: `#${stageId}`,
        assetPath: `${import.meta.env.BASE_URL}assets/dice-box/`,
        origin: window.location.origin,
        theme: 'default',
        themeColor: '#d4a45a',
        scale: 8,
        enableShadows: true,
        shadowTransparency: 0.65,
        lightIntensity: 1.05,
        // Offscreen workers often never finish init under Vite (GM_Helper).
        offscreen: false,
        delay: 12,
      });
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          instance.init(),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error('3D dice engine timed out'));
            }, initTimeoutMs);
          }),
        ]);
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
      if (attemptRef.current !== attempt) {
        tearDown();
        return;
      }
      boxRef.current = instance;
      setStatus('ready');
    };

    void boot().catch((bootError: unknown) => {
      if (attemptRef.current !== attempt) {
        return;
      }
      tearDown();
      const message =
        bootError instanceof Error ? bootError.message : '3D dice failed to initialize';
      fail(message, bootError);
    });
  }, [fail, initTimeoutMs, tearDown]);

  const ensureStarted = useCallback((): void => {
    if (status !== 'idle') {
      return;
    }
    attemptRef.current += 1;
    start();
  }, [start, status]);

  const retry = useCallback((): void => {
    attemptRef.current += 1;
    tearDown();
    start();
  }, [start, tearDown]);

  const rollDice = useCallback(async (notation: string[]): Promise<DiceBoxRollDie[]> => {
    const box = boxRef.current;
    if (box === null) {
      throw new Error('3D dice are not ready yet');
    }
    return box.roll(notation);
  }, []);

  const clearDice = useCallback((): void => {
    try {
      boxRef.current?.clear();
    } catch (clearError: unknown) {
      toastError('Could not clear the dice', clearError);
    }
  }, []);

  useEffect(
    () => () => {
      attemptRef.current += 1;
      tearDown();
    },
    [tearDown],
  );

  return { status, error, stageRef, ensureStarted, retry, rollDice, clearDice };
}
