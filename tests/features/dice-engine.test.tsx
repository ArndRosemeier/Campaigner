import 'fake-indexeddb/auto';

import { useEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDiceEngine, type DiceEngine } from '@/features/dice/useDiceEngine';

/**
 * The dice engine hook against a mocked `@3d-dice/dice-box` (jsdom has no
 * WebGL): loud init failure + timeout, idempotent start, retry, the roll
 * contract, and teardown. The engine is never silently degraded — every
 * failure must land in the error state (inline status) and the toast seam.
 */

const h = vi.hoisted(() => {
  const state = {
    initImpl: undefined as undefined | (() => Promise<unknown>),
    rollImpl: undefined as undefined | (() => Promise<unknown>),
    instances: [] as {
      config: Record<string, unknown>;
      initCalls: number;
      rollNotations: unknown[];
      cleared: number;
    }[],
  };
  return state;
});

vi.mock('@3d-dice/dice-box', () => ({
  default: class FakeDiceBox {
    config: Record<string, unknown>;
    initCalls = 0;
    rollNotations: unknown[] = [];
    cleared = 0;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      h.instances.push(this);
    }
    init(): Promise<unknown> {
      this.initCalls += 1;
      return h.initImpl === undefined ? Promise.resolve(this) : h.initImpl();
    }
    roll(notation: unknown): Promise<unknown> {
      this.rollNotations.push(notation);
      return h.rollImpl === undefined
        ? Promise.resolve([{ value: 4, sides: 6 }])
        : h.rollImpl();
    }
    clear(): void {
      this.cleared += 1;
    }
  },
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ toastError }));

function lastInstance(): { config: Record<string, unknown>; cleared: number } {
  const instance = h.instances.at(-1);
  if (instance === undefined) throw new Error('engine was never constructed');
  return instance;
}

let captured: DiceEngine | null = null;

/** Harness that mounts the stage div the hook needs for engine init. */
function Harness({ initTimeoutMs }: { initTimeoutMs?: number | undefined }) {
  const engine = useDiceEngine(initTimeoutMs === undefined ? {} : { initTimeoutMs });
  useEffect(() => {
    captured = engine;
  });
  return <div ref={engine.stageRef} data-testid="dice-stage" />;
}

function renderEngine(initTimeoutMs?: number): void {
  captured = null;
  render(<Harness initTimeoutMs={initTimeoutMs} />);
}

/** Drain enough microtask ticks for the mocked dynamic import + init chain. */
async function flushTicks(ticks = 6): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await Promise.resolve();
  }
}

/** The hook's LATEST render snapshot — status updates are new objects. */
function currentEngine(): DiceEngine {
  if (captured === null) throw new Error('engine was not captured');
  return captured;
}

beforeEach(() => {
  h.initImpl = undefined;
  h.rollImpl = undefined;
  h.instances.length = 0;
  toastError.mockClear();
  cleanup();
});

describe('useDiceEngine', () => {
  it('starts lazily, dynamic-imports the engine, and reaches ready', async () => {
    renderEngine();
    await act(async () => {
      currentEngine().ensureStarted();
      await flushTicks();
    });
    const engine = currentEngine();
    expect(engine.status).toBe('ready');
    expect(engine.error).toBeNull();
    // The engine config pins the Vite workarounds: base-relative assets,
    // offscreen workers off, and the theme GM_Helper proved out.
    const config = lastInstance().config;
    expect(config.assetPath).toBe('/assets/dice-box/');
    expect(config.offscreen).toBe(false);
    expect(config.theme).toBe('default');
  });

  it('is idempotent — ensureStarted after ready constructs no further engine', async () => {
    renderEngine();
    await act(async () => {
      currentEngine().ensureStarted();
      await flushTicks();
    });
    await act(async () => {
      currentEngine().ensureStarted();
      currentEngine().ensureStarted();
      await flushTicks();
    });
    expect(h.instances).toHaveLength(1);
    expect(currentEngine().status).toBe('ready');
  });

  it('fails loudly when init rejects: error state + toast, never a silent degrade', async () => {
    h.initImpl = () => Promise.reject(new Error('no WebGL context'));
    renderEngine();
    await act(async () => {
      currentEngine().ensureStarted();
      await flushTicks();
    });
    const engine = currentEngine();
    expect(engine.status).toBe('error');
    expect(engine.error).toBe('no WebGL context');
    expect(toastError).toHaveBeenCalledWith(
      '3D dice failed to load',
      expect.objectContaining({ message: 'no WebGL context' }),
    );
  });

  it('times out a hung init and reports it loudly', async () => {
    h.initImpl = () => new Promise(() => undefined);
    renderEngine(40);
    await act(async () => {
      currentEngine().ensureStarted();
      await flushTicks();
    });
    await waitFor(() => {
      expect(currentEngine().status).toBe('error');
    });
    expect(currentEngine().error).toBe('3D dice engine timed out');
    expect(toastError).toHaveBeenCalled();
  });

  it('retry clears the error and boots a fresh instance', async () => {
    h.initImpl = () => Promise.reject(new Error('first boot failed'));
    renderEngine();
    await act(async () => {
      currentEngine().ensureStarted();
      await flushTicks();
    });
    expect(currentEngine().status).toBe('error');
    h.initImpl = undefined;
    await act(async () => {
      currentEngine().retry();
      await flushTicks();
    });
    expect(currentEngine().status).toBe('ready');
    expect(currentEngine().error).toBeNull();
    expect(h.instances).toHaveLength(2);
  });

  it('refuses to roll before the engine is ready', async () => {
    renderEngine();
    await expect(currentEngine().rollDice(['2d6'])).rejects.toThrow('3D dice are not ready yet');
  });

  it('rolls grouped notation and clears on demand once ready', async () => {
    renderEngine();
    await act(async () => {
      currentEngine().ensureStarted();
      await flushTicks();
    });
    const rolls = await currentEngine().rollDice(['2d6', '1d100']);
    expect(rolls).toEqual([{ value: 4, sides: 6 }]);
    expect(lastInstance().config.container).toMatch(/^#dice-stage-\d+$/);
    currentEngine().clearDice();
    expect(lastInstance().cleared).toBe(1);
  });

  it('propagates roll failures to the caller instead of swallowing them', async () => {
    renderEngine();
    await act(async () => {
      currentEngine().ensureStarted();
      await flushTicks();
    });
    h.rollImpl = () => Promise.reject(new Error('physics worker crashed'));
    await expect(currentEngine().rollDice(['2d6'])).rejects.toThrow('physics worker crashed');
  });

  it('tears the engine down on unmount', async () => {
    renderEngine();
    await act(async () => {
      currentEngine().ensureStarted();
      await flushTicks();
    });
    await act(async () => {
      cleanup();
      await flushTicks();
    });
    expect(lastInstance().cleared).toBe(1);
  });
});
