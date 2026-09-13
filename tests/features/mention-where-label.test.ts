import 'fake-indexeddb/auto';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, listArtifactsByCampaign, listArtifactsByModule } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import {
  createModule,
  getModule,
  listModulesByCampaign,
  patchModulePartText,
  saveSpine,
} from '@/db/moduleRepo';
import { evaluateOrphanGuards, sweepOrphanedArtifacts } from '@/db/orphanSweep';
import { createModule as createModuleRow, type Id } from '@/domain';
import { whereLabel } from '@/features/campaign/mentionView';
import { computeCampaignGrounding } from '@/llm/campaignGrounding';
import { clearDatabase } from '../db/helpers';

/**
 * THE `where` LABEL CONVENTION — its "exactly one" pin (AGENTS §Centralization
 * item 2, docs/17 row 145, docs/14 §2).
 *
 * ## Why this file exists
 *
 * `'premise' | 'part-<planIndex>'` is the derivation's document convention, and
 * TWO implementations of "render it for a person" existed: the declared home
 * `features/campaign/mentionView.whereLabel` ("Premise" / "Part N") and a
 * PRIVATE byte-identical copy in `llm/campaignGrounding` that differed only by
 * the absent `export`. Nothing failed while both were correct — that is what
 * duplication looks like when it is BORN — and the copy's output is STORED:
 * it is written as `source` on every `ExpansionExcerpt`, persisted on the run
 * row's `expansionExcerpts` and rendered back into the prompt on resume, where
 * the zod boundary is a bare `source: z.string()` and pins no convention at
 * rest. The copy is deleted and the home imported; the stored-output pins that
 * already existed are the byte-preservation proof.
 *
 * ## The ONE deliberate second spelling, declared as data
 *
 * `db/orphanSweep.whereLabel` is NOT a copy: its output is lowercase PROSE
 * (`premise` / `part N`) embedded mid-sentence in a user-visible refusal
 * ("mentioned in campaign prose — "Tide Gate" premise ×1") and is pinned
 * case-sensitively. The owner was shown both spellings and agreed to keep them.
 * The differential below therefore requires the two same-convention copies to be
 * IDENTICAL and states the third as `label.toLowerCase()` — named, intentional
 * data, so the next reader cannot mistake one for drift.
 */
const CASES: readonly { readonly where: string; readonly label: string; readonly prose: string }[] = [
  { where: 'premise', label: 'Premise', prose: 'premise' },
  { where: 'part-0', label: 'Part 1', prose: 'part 1' },
  { where: 'part-1', label: 'Part 2', prose: 'part 2' },
  { where: 'part-11', label: 'Part 12', prose: 'part 12' },
];

const TITLE = 'Ashen Vault';
const NAME = 'Grix';

beforeEach(clearDatabase);

/** A campaign + module + module-owned npc, with `[[Grix]]` in ONE document. */
async function fixture(where: string): Promise<{ campaignId: Id; moduleId: Id }> {
  const campaign = await createCampaign({ name: 'Where label', system: 'dnd5e' });
  const module = await createModule(
    createModuleRow({
      campaignId: campaign.id,
      title: TITLE,
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    }),
  );
  await saveSpine(module.id, {
    premise: where === 'premise' ? `[[${NAME}]].` : 'Nothing here.',
    themes: [],
    writerModel: '',
    origin: null,
    partPlan: [
      {
        title: 'The Forge',
        levelBand: '1–2',
        synopsis: 'Reach the forge.',
        levelUpTrigger: 'The forge goes cold.',
      },
    ],
  });
  if (where !== 'premise') {
    await patchModulePartText(module.id, Number(where.slice('part-'.length)), `[[${NAME}]] brews by the forge.`);
  }
  await createArtifact({ campaignId: campaign.id, moduleId: module.id, kind: 'npc', name: NAME });
  return { campaignId: campaign.id, moduleId: module.id };
}

describe('the shared sample: every copy the same inputs', () => {
  it('has cases on both sides of the convention', () => {
    expect(CASES).toHaveLength(4);
    expect(CASES.map((entry) => entry.label)).toEqual(['Premise', 'Part 1', 'Part 2', 'Part 12']);
    // Non-vacuity: EVERY case really is two spellings of one convention — each
    // differs (4/4) and each differs ONLY by case (4/4), which is the declared
    // relation and not drift. The case row is typed as plain strings rather than
    // `as const`, so this is a real comparison instead of a literal-union
    // comparison TS narrows away.
    expect(CASES.filter((entry) => entry.label !== entry.prose)).toHaveLength(4);
    expect(CASES.filter((entry) => entry.label.toLowerCase() === entry.prose)).toHaveLength(4);
  });

  it.each(CASES.map((entry) => [entry.where, entry] as const))(
    'the HOME renders %s',
    (_where, entry) => {
      expect(whereLabel(entry.where)).toBe(entry.label);
    },
  );

  it.each(CASES.map((entry) => [entry.where, entry] as const))(
    'the STORED grounding source agrees byte-for-byte at %s',
    async (where, entry) => {
      const { campaignId, moduleId } = await fixture(where);
      const modules = [await moduleRow(moduleId)];
      const pool = await campaignPool(campaignId);
      const excerpts = computeCampaignGrounding({
        brief: `A scene with [[${NAME}]].`,
        modules,
        pool,
      });
      expect(excerpts).toHaveLength(1);
      // The STORED `source` — the string that reaches the run row and is
      // rendered back into the prompt on resume.
      expect(excerpts[0]?.source).toBe(`${TITLE} — ${entry.label}`);
      expect(excerpts[0]?.where).toBe(where);
    },
  );

  it.each(CASES.map((entry) => [entry.where, entry] as const))(
    'the SWEEP refusal states the DECLARED lowercase prose at %s',
    async (where, entry) => {
      const { campaignId, moduleId } = await fixture(where);
      // THE one guard evaluation both the sweep and the panel call
      // (`orphanSweep.evaluateOrphanGuards`; docs/17 row 92) — the same function
      // whose reason string reaches the user-visible refusal.
      const evaluation = evaluateOrphanGuards(await listArtifactsByModule(moduleId), {
        module: await moduleRow(moduleId),
        campaignModules: await listModulesByCampaign(campaignId),
        pool: await campaignPool(campaignId),
        battles: [],
      });
      expect(evaluation.verdicts).toHaveLength(1);
      expect(evaluation.verdicts[0]?.refusal?.guard).toBe('campaign-mention');
      expect(evaluation.verdicts[0]?.refusal?.reason).toBe(
        `mentioned in campaign prose — "${TITLE}" ${entry.prose} ×1`,
      );
      // The declared difference, stated as ONE relation rather than two
      // unrelated tables: same convention, lowercase prose.
      expect(entry.prose).toBe(entry.label.toLowerCase());
    },
  );

  it('the sweep agrees: a row the evaluation keeps is never deleted', async () => {
    const { moduleId } = await fixture('part-0');
    const outcome = await sweepOrphanedArtifacts(moduleId);
    expect(outcome.deleted).toEqual([]);
    expect(outcome.kept).toEqual([]);
  });
});

// --- The "exactly one" half: the SOURCE -------------------------------

const SRC = 'src';

function srcFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir)).sort()) {
    const path = `${dir}/${entry}`;
    if (statSync(join(process.cwd(), path)).isDirectory()) out.push(...srcFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

const source = (file: string): string => readFileSync(join(process.cwd(), file), 'utf8');

describe('the renderer is ONE function, and the second spelling is the declared one', () => {
  it('declares `function whereLabel` in exactly the home and the declared prose copy', () => {
    const files = srcFiles();
    // Non-vacuity: the walk must see the whole `src/` tree.
    expect(files.length).toBeGreaterThan(200);

    const declaring = files.filter((file) => source(file).includes('function whereLabel('));
    expect(declaring).toEqual([
      'src/db/orphanSweep.ts',
      'src/features/campaign/mentionView.ts',
    ]);
    // The copy that was deleted must stay deleted: no `whereLabel` body of its
    // own anywhere in `llm/`, and the home's is the one it imports.
    expect(files.filter((file) => file.startsWith('src/llm/') && source(file).includes('function whereLabel(')))
      .toEqual([]);
    expect(source('src/llm/campaignGrounding.ts')).toContain(
      "import { whereLabel } from '@/features/campaign/mentionView';",
    );
    // …and the STORED `source` is built from it, not from a local spelling.
    expect(source('src/llm/campaignGrounding.ts')).toContain(
      'source: `${module.title} — ${whereLabel(mention.where)}`',
    );
  });

  it("the declared carve-out still holds its copy — a stale carve-out must not outlive its cause", () => {
    // The lowercase prose body: two named shapes and a LOUD throw for anything
    // else (never the old invented values — `''` → `part 1`).
    const sweep = source('src/db/orphanSweep.ts');
    expect(sweep).toContain("if (where === 'premise') return 'premise';");
    expect(sweep).toContain('return `part ${String(Number(match[1]) + 1)}`;');
    expect(sweep).toContain('sweepOrphanedArtifacts: unknown mention document');
    expect(sweep).not.toContain("where.slice('part-'.length)");
  });

  it('the home keeps the two shapes and renders anything else VERBATIM (its own documented contract)', () => {
    expect(whereLabel('part-3')).toBe('Part 4');
    // NOT an error and NOT an invention — the reader-facing helper's own stated
    // behaviour, which is why only the SWEEP got the loud guard (docs/17 row 145).
    expect(whereLabel('overview')).toBe('overview');
  });
});

/** The stored module row, parsed (the derivation's own input shape). */
async function moduleRow(moduleId: Id) {
  const module = await getModule(moduleId);
  if (module === undefined) throw new Error(`no module ${moduleId}`);
  return module;
}

/** The reader's resolution pool for the fixture campaign. */
async function campaignPool(campaignId: Id) {
  return listArtifactsByCampaign(campaignId);
}
