import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * ONE thing decides the KIND of a hand-typed entity: the module's RECORDED kind
 * or the ONE structured model classification. Never a pattern over the sentence
 * (docs/17 row 293, AGENTS rule 5).
 *
 * THE DEFECT THIS FORBIDS, measured. `features/modules/persona-request.
 * guessKindFromSentence` lowercased the first-occurrence SENTENCE and matched
 * two ENGLISH alternations — `at|in|inside|near|beneath|under|above|beyond|
 * through` ⇒ `location`, `guild|order|court|cult|clan|company|syndicate|crew|
 * government|council` ⇒ `faction`, else `npc` — and `stub-popover.tsx:93`
 * rendered that answer as the DEFAULT kind:
 * `useState<StubKind>(recordedKind ?? guessKindFromSentence(sentence))`. A German
 * sentence ("Die Gilde im Keller") matched NEITHER pattern and was shown as an
 * `npc`: a wrong read of free text presented as the answer, before the model
 * call that existed for exactly this purpose could correct it.
 *
 * WHAT IS PINNED, and why a SOURCE scan rather than only the rendered arms in
 * `tests/features/stub-popover-kind.test.tsx`: a resurrected guesser that is
 * never reached on today's fixtures is invisible to behaviour, and the drift
 * this file exists to catch is the copy BORN tomorrow. The pair is small enough
 * that the honest statement is exact: the function is gone tree-wide, and the
 * two files that own this decision contain no pattern machinery at all.
 *
 * THE SEARCH IS DECLARED, not implied: comments and formatting are stripped by
 * `tests/helpers/sourceCode` (so this docstring naming the deleted regex is not
 * itself a hit), and the pair is required to contain NONE of
 * `new RegExp`, `.test(`, `.exec(`, `.match(`, `.matchAll(` — the constructor
 * and the four call shapes any keyword classifier is USED through. A regex
 * literal alone decides nothing, so it needs one of them to be a guesser again.
 * The positive halves below prove the scan is reading the right bytes.
 */
const PERSONA_REQUEST = 'src/features/modules/persona-request.ts';
const STUB_POPOVER = 'src/features/modules/stub-popover.tsx';

/** The constructor and call shapes a pattern needs to classify anything. */
const PATTERN_SHAPES = ['new RegExp', '.test(', '.exec(', '.match(', '.matchAll('] as const;

describe('ONE source decides a hand-typed entity kind (docs/17 row 293, AGENTS rule 5)', () => {
  it('has DELETED the keyword guesser from the whole tree', () => {
    // Non-vacuity: the walk sees the tree (the helper's glob is `src/**`), and
    // the needle would otherwise be trustworthy only by its absence.
    expect(Object.keys(CODE).length).toBeGreaterThan(300);
    expect(filesWith('guessKindFromSentence')).toEqual([]);
  });

  it('takes the kind from the recorded record or the model verdict, and from NO pattern', () => {
    const popover = CODE[STUB_POPOVER] ?? '';
    const persona = CODE[PERSONA_REQUEST] ?? '';
    // The scan must be reading real, comment-stripped bytes of BOTH files.
    expect(popover.length, `${STUB_POPOVER} was found and read`).toBeGreaterThan(1_000);
    expect(persona.length, `${PERSONA_REQUEST} was found and read`).toBeGreaterThan(1_000);

    // THE ONE SOURCE, at the ONE place the state is born: the recorded kind
    // when the module has one, and otherwise NOTHING — the state starts
    // unselected while the classification is in flight.
    expect(popover).toContain('useState<StubKind | null>(recordedKind ?? null)');
    // …and it is the MODEL's verdict that sets it, guarded by the owner's pick.
    expect(popover).toContain('if (!userPickedRef.current) setKind(classified.kind)');

    // No pattern machinery survives in either file of the pair. A resurrected
    // heuristic reds here BY FILE AND SHAPE, whatever it is named.
    for (const shape of PATTERN_SHAPES) {
      expect(popover, `${STUB_POPOVER} must not contain "${shape}"`).not.toContain(shape);
      expect(persona, `${PERSONA_REQUEST} must not contain "${shape}"`).not.toContain(shape);
    }
  });
});
