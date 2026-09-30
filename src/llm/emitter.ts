/**
 * THE in-memory emitter primitive — one listener set, one `on` contract
 * (AGENTS rule 4; docs/17 row 313).
 *
 * WHY THIS EXISTS. Three classes hand-rolled the same EventEmitter shape —
 * `RunEngine`, `ChainRunner` and `moduleGen`'s event bus — each keeping its own
 * `Set` of listeners, adding on subscribe, returning the deleting unsubscribe
 * and iterating the set to publish. The copies were invisible while they were
 * born (each was correct where it was written) and the duplicate-body tripwire
 * named them as ONE group (baseline hash `6cb7f0cd682b51d6`; docs/18 §5). The
 * event PAYLOAD is the only thing that differs between the three, so the
 * primitive is generic and the emitting classes keep their own public surface.
 *
 * COMPOSED, NOT INHERITED. The three users expose different public surfaces
 * (`RunEngine.on`, `ChainRunner.on`, the exported `moduleGenEvents` bus), so
 * each holds a private instance and delegates through a one-line `on`; a base
 * class would have to publish an `emit` the two engine classes deliberately
 * keep private.
 *
 * The HOME is `src/llm` rather than `lib/` on purpose: all three users are in
 * this layer, and `lib/` holds CROSS-CUTTING helpers (docs/18 §1) — a primitive
 * with three same-layer callers is not one yet, and a `lib/` home would be the
 * speculative generality rule 4's KISS half forbids. A future caller outside
 * `llm` imports this subpath (`features → llm` is downward).
 *
 * NOT this shape, deliberately (docs/18 §2): `features/modules/streamTails`
 * and `app/layout/build-status` each hold a `Set` of listeners too, but both
 * are `useSyncExternalStore` SUBSCRIPTIONS — one filters by a key, the other
 * starts its read on the first subscriber — so they are a different job, not a
 * fourth copy.
 */
export class Emitter<T> {
  private readonly listeners = new Set<(event: T) => void>();

  /** Subscribes; the returned function unsubscribes. */
  on(listener: (event: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: T): void {
    for (const listener of this.listeners) listener(event);
  }
}
