import type { Content, Style, TDocumentDefinitions } from 'pdfmake/interfaces';

import type { AnyArtifact, Deliverable, OutlineNode, StatBlock } from '@/domain';
import { resolveMonsterEntries } from '@/db/monsterResolve';
import { getImage } from '@/db/imageRepo';
import { blobToScaledDataUrl } from '@/lib/imageIntake';
import { mdToPdfmakeContent } from '@/lib/mdToPdfmake';

/**
 * Module PDF renderer (07-MILESTONE-3 M3-D): renders a curated Deliverable
 * outline as an adventure-module PDF — cover page, generated ToC, chapter
 * banners with kickers, boxed read-aloud quotes, labeled per-kind sections,
 * two-column stat boxes, images at ≤45% width, and NPC-gallery /
 * treasure-ledger appendices. The GM/player audience switch strips secrets,
 * GM-only nodes, and encounter tactics/treasure. The build never fails on
 * missing data: dangling refs render a visible placeholder.
 */

const ACCENT = '#9a7b4f';

/** Small-caps kicker line above part/artifact headers ("Kapitel 2 · …"). */
function kicker(text: string): Content {
  return {
    text: text.toUpperCase(),
    style: 'kicker',
  };
}

function labeledSection(label: string, body: string): Content | null {
  if (body.trim() === '') return null;
  return {
    text: [
      { text: `${label}: `, bold: true, style: 'label' },
      { text: body },
    ],
    margin: [0, 0, 0, 3],
  };
}

/** Bordered two-column stat box (M2 export layout, module styling). */
export function statBoxContent(statBlock: StatBlock, name: string): Content {
  const left: Content[] = [
    { text: [statBlock.size, statBlock.creatureType, statBlock.level].filter((part) => part !== '').join(', ') },
    {
      text: [
        { text: 'AC ', bold: true },
        { text: `${statBlock.ac}${statBlock.acNote === '' ? '' : ` (${statBlock.acNote})`}` },
        { text: '  HP ', bold: true },
        { text: `${statBlock.hp}${statBlock.hpFormula === '' ? '' : ` (${statBlock.hpFormula})`}` },
        { text: '  Speed ', bold: true },
        { text: statBlock.speed },
      ],
      margin: [0, 4, 0, 4],
    },
  ];
  const abilities = Object.entries(statBlock.abilities)
    .map(([key, value]) => `${key.toUpperCase()} ${value}`)
    .join('  ');
  const right: Content[] = [
    { text: abilities },
    labeledSection('Saves', statBlock.saves),
    labeledSection('Skills', statBlock.skills),
    labeledSection('Senses', statBlock.senses),
    labeledSection('Languages', statBlock.languages),
  ].filter((entry): entry is Content => entry !== null);
  return {
    table: {
      widths: ['*', '*'],
      body: [
        [{ colSpan: 2, text: name, bold: true, style: 'h3' }, ''],
        [left, right],
        [
          {
            colSpan: 2,
            stack: [
              ...statBlock.traits.map((trait): Content =>
                labeledSection(trait.name, trait.text) ?? { text: trait.text },
              ),
            ],
          },
          '',
        ],
        [
          {
            colSpan: 2,
            stack: statBlock.actions.map((action): Content =>
              labeledSection(action.name, action.text) ?? { text: action.text },
            ),
          },
          '',
        ],
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => ACCENT,
      vLineColor: () => ACCENT,
      paddingLeft: () => 6,
      paddingRight: () => 6,
      paddingTop: () => 4,
      paddingBottom: () => 4,
    },
    margin: [0, 6, 0, 6],
  };
}

/** imageId → data URL map, pre-loaded by buildModulePdf. */
export type ModulePdfImages = Record<string, string | undefined>;

interface RenderContext {
  deliverable: Deliverable;
  artifacts: readonly AnyArtifact[];
  images: ModulePdfImages;
  /** Artifact ids reachable in the outline (for internal links). */
  outlineArtifactIds: Set<string>;
}

/** GM-only tag: artifacts tagged so are skipped for audience 'player'. */
const GM_ONLY_TAG = 'gm-only';

function isGmOnly(artifact: AnyArtifact): boolean {
  return artifact.tags.includes(GM_ONLY_TAG);
}

function collectOutlineArtifactIds(nodes: readonly OutlineNode[], into: Set<string>): void {
  for (const node of nodes) {
    if (node.type === 'chapter' || node.type === 'part') {
      collectOutlineArtifactIds(node.children, into);
    } else if (node.type === 'artifact') {
      into.add(node.artifactId);
    }
  }
}

interface WalkState {
  content: Content[];
  /** Set to the enclosing chapter title for kicker lines. */
  chapter: string | null;
}

/** Per-kind labeled data sections (the book's description → creatures → …). */
function dataSections(
  artifact: AnyArtifact,
  audience: 'gm' | 'player',
  statBlocks: boolean,
): Content[] {
  const out: Content[] = [];
  if (artifact.kind === 'pc') {
    // M5-A: the player variant renders the PC card (name, portrait, HP) with
    // no notes — notes may carry secrets and never reach the player PDF.
    pushSections(
      out,
      labeledSection('Current HP', String(artifact.data.currentHp)),
      audience === 'gm' ? labeledSection('Notes', artifact.data.notes) : null,
    );
    if (statBlocks && artifact.data.statBlock !== null) {
      pushSections(out, statBoxContent(artifact.data.statBlock, artifact.name));
    }
  } else if (artifact.kind === 'npc') {
    pushSections(
      out,
      labeledSection('Role', artifact.data.role),
      labeledSection('Appearance', artifact.data.appearance),
      labeledSection('Personality', artifact.data.personality),
      labeledSection('Motivation', artifact.data.motivation),
      labeledSection('Voice', artifact.data.voiceNotes),
      audience === 'gm' ? labeledSection('Secrets', artifact.data.secrets) : null,
    );
    if (statBlocks && artifact.data.statBlock !== null) {
      pushSections(out, statBoxContent(artifact.data.statBlock, artifact.name));
    }
  } else if (artifact.kind === 'faction') {
    pushSections(
      out,
      labeledSection('Goals', artifact.data.goals),
      audience === 'gm' ? labeledSection('Methods', artifact.data.methods) : null,
      labeledSection('Resources', artifact.data.resources),
      ...artifact.data.ranks.map((rank): Content | null =>
        labeledSection(rank.title, rank.description),
      ),
    );
  } else if (artifact.kind === 'encounter') {
    pushSections(
      out,
      monsterHeaderKicker(artifact.data.difficulty, artifact.data.levelHint),
      ...artifact.data.monsters.map((monster): Content => {
        const stats =
          statBlocks && monster.source.type === 'inline'
            ? [statBoxContent(monster.source.statBlock, `${monster.name} ×${monster.count}`)]
            : [];
        const origin: { text: string; italics: boolean }[] =
          monster.source.type === 'rulebook' ? [{ text: ' (see Bestiary)', italics: true }] : [];
        return {
          stack: [
            {
              text: [
                { text: monster.name, bold: true },
                { text: ` ×${monster.count}` },
                ...origin,
              ],
            },
            ...(monster.notes === '' ? [] : [{ text: monster.notes, style: 'muted' }]),
            ...stats,
          ],
          margin: [0, 0, 0, 3],
        };
      }),
      audience === 'gm' ? labeledSection('Terrain', artifact.data.terrain) : null,
      audience === 'gm' ? labeledSection('Tactics', artifact.data.tactics) : null,
      audience === 'gm' ? labeledSection('Treasure', artifact.data.treasure) : null,
    );
  } else if (artifact.kind === 'plotarc') {
    pushSections(
      out,
      labeledSection('Premise', artifact.data.premise),
      labeledSection('Stakes', artifact.data.stakes),
      ...artifact.data.beats.map((beat): Content | null => labeledSection(beat.title, beat.description)),
      ...artifact.data.hooks.map((hook): Content => ({ text: [{ text: 'Hook: ', bold: true }, { text: hook }] })),
      labeledSection('Climax', artifact.data.climax),
    );
  } else {
    void artifact;
  }
  return out;
}

/** Pushes labeled sections, dropping null (empty) ones. */
function pushSections(out: Content[], ...items: (Content | null)[]): void {
  for (const item of items) {
    if (item !== null) out.push(item);
  }
}

function monsterHeaderKicker(difficulty: string, levelHint: string): Content | null {
  if (difficulty === '' && levelHint === '') return null;
  return {
    text: [difficulty, levelHint].filter((part) => part !== '').join(' · ').toUpperCase(),
    style: 'kicker',
    margin: [0, 2, 0, 4],
  };
}

function artifactBody(artifact: AnyArtifact, ctx: RenderContext, include: { body: boolean; data: boolean; statBlocks: boolean; images: boolean }): Content[] {
  const out: Content[] = [];
  if (include.images && artifact.coverImageId !== null) {
    const dataUrl = ctx.images[artifact.coverImageId];
    if (dataUrl !== undefined) {
      // Locations may span full width; everything else ≤45% via columns.
      if (artifact.kind === 'location') {
        out.push({ image: dataUrl, fit: [450, 320], margin: [0, 0, 0, 6] });
      } else {
        // pdfmake has no float: thumbnails sit in a ≤45% column.
        out.push({
          columns: [
            { image: dataUrl, fit: [200, 150] },
            { text: '', width: '55%' },
          ],
          margin: [0, 0, 0, 6],
        });
      }
    }
  }
  if (include.body && artifact.body.trim() !== '') {
    out.push(...mdToPdfmakeContent(artifact.body));
  }
  if (include.data) {
    out.push(...dataSections(artifact, ctx.deliverable.audience, include.statBlocks));
  }
  if (include.data && artifact.links.length > 0) {
    const byId = new Map(ctx.artifacts.map((entry) => [entry.id, entry]));
    const refs: Content[] = artifact.links.flatMap((link): Content[] => {
      const target = byId.get(link.targetId);
      if (target === undefined) return [];
      if (ctx.outlineArtifactIds.has(link.targetId)) {
        return [{
          text: `see ${target.name}`,
          italics: true,
          linkToDestination: `node-${link.targetId}`,
          margin: [0, 0, 0, 2],
        }];
      }
      return [{ text: `see ${target.name}`, italics: true, margin: [0, 0, 0, 2] }];
    });
    if (refs.length > 0) out.push({ text: refs, margin: [0, 4, 0, 0] });
  }
  return out;
}

function walk(nodes: readonly OutlineNode[], ctx: RenderContext, state: WalkState): void {
  const byId = new Map(ctx.artifacts.map((entry) => [entry.id, entry]));
  const player = ctx.deliverable.audience === 'player';

  for (const node of nodes) {
    if (node.type === 'chapter') {
      state.content.push({
        text: node.title,
        style: 'chapter',
        tocItem: 'chapters',
        id: `node-chapter-${state.content.length}`,
        pageBreak: 'before',
      });
      state.chapter = node.title;
      walk(node.children, ctx, state);
      state.chapter = null;
    } else if (node.type === 'part') {
      state.content.push(kicker(state.chapter ?? ''));
      state.content.push({ text: node.title, style: 'part', tocItem: 'chapters' });
      walk(node.children, ctx, state);
    } else if (node.type === 'text') {
      state.content.push(...mdToPdfmakeContent(node.markdown));
    } else if (node.type === 'gallery') {
      if (node.gallery === 'npcs') {
        const npcs = ctx.artifacts.filter((entry) => entry.kind === 'npc' && (!player || !isGmOnly(entry)));
        if (npcs.length === 0) continue;
        if (state.chapter !== null) state.content.push(kicker(state.chapter));
        state.content.push({ text: 'NPC Gallery', style: 'part', tocItem: 'chapters' });
        for (const npc of npcs) {
          state.content.push(...artifactBody(npc, ctx, { body: true, data: true, statBlocks: true, images: false }));
        }
      } else {
        const ledger = ctx.artifacts.flatMap((entry): { name: string; treasure: string }[] =>
          entry.kind === 'encounter' && entry.data.treasure.trim() !== ''
            ? [{ name: entry.name, treasure: entry.data.treasure }]
            : [],
        );
        if (ledger.length === 0) continue;
        if (state.chapter !== null) state.content.push(kicker(state.chapter));
        state.content.push({ text: 'Treasure', style: 'part', tocItem: 'chapters' });
        state.content.push({
          table: {
            widths: ['*', '*'],
            body: [
              [{ text: 'Encounter', bold: true }, { text: 'Treasure', bold: true }],
              ...ledger.map((row) => [row.name, row.treasure]),
            ],
          },
          layout: 'lightHorizontalLines',
        });
      }
    } else {
      const artifact = byId.get(node.artifactId);
      if (artifact === undefined) {
        state.content.push({
          table: {
            widths: ['*'],
            body: [[{ text: 'missing artifact', italics: true, color: '#b91c1c' }]],
          },
          layout: {
            hLineWidth: () => 1,
            vLineWidth: () => 1,
            hLineColor: () => '#b91c1c',
            vLineColor: () => '#b91c1c',
            paddingLeft: () => 8,
            paddingRight: () => 8,
            paddingTop: () => 6,
            paddingBottom: () => 6,
          },
          margin: [0, 4, 0, 4],
        });
        continue;
      }
      if (player && isGmOnly(artifact)) continue;
      if (player && artifact.kind === 'note') continue;
      state.content.push(kicker(state.chapter ?? ''));
      state.content.push({
        text: artifact.name,
        style: 'artifact',
        tocItem: 'chapters',
        id: `node-${artifact.id}`,
      });
      state.content.push(
        ...artifactBody(
          artifact,
          ctx,
          {
            body: node.include.body,
            data: node.include.data,
            statBlocks: node.include.statBlocks,
            images: node.include.images,
          },
        ),
      );
    }
  }
}

export function buildModuleDefinition(
  deliverable: Deliverable,
  artifacts: readonly AnyArtifact[],
  images: ModulePdfImages = {},
): TDocumentDefinitions {
  const outlineArtifactIds = new Set<string>();
  collectOutlineArtifactIds(deliverable.outline, outlineArtifactIds);
  // Owned rows may feed generated gallery/ledger nodes. Library rows enter
  // PDF context only when the outline names them explicitly (M6-D).
  const visibleArtifacts = artifacts.filter(
    (artifact) => artifact.campaignId !== null || outlineArtifactIds.has(artifact.id),
  );
  const ctx: RenderContext = {
    deliverable,
    artifacts: visibleArtifacts,
    images,
    outlineArtifactIds,
  };
  const state: WalkState = { content: [], chapter: null };

  const cover: Content[] = [
    { text: deliverable.title, style: 'coverTitle', margin: [0, 120, 0, 8] },
    { text: deliverable.subtitle, style: 'coverSubtitle' },
  ];
  const coverUrl =
    deliverable.coverImageId !== null ? images[deliverable.coverImageId] : undefined;
  if (coverUrl !== undefined) {
    cover.push({
      image: coverUrl,
      fit: [300, 300],
      alignment: 'center',
      margin: [0, 24, 0, 0],
    });
  }
  cover.push({
    text: `Compiled with Campaigner · ${new Date().toISOString().slice(0, 10)}`,
    style: 'muted',
    alignment: 'center',
    margin: [0, 24, 0, 0],
  });

  walk(deliverable.outline, ctx, state);
  const content: Content[] = [
    ...cover,
    { text: 'Contents', style: 'part', pageBreak: 'before' },
    { toc: { id: 'chapters', title: { text: 'Contents', style: 'part' } } },
    ...state.content,
  ];

  const styles: Record<string, Style> = {
    coverTitle: { fontSize: 32, bold: true, alignment: 'center' },
    coverSubtitle: { fontSize: 16, italics: true, alignment: 'center', color: '#555555' },
    chapter: { fontSize: 26, bold: true, margin: [0, 0, 0, 10] },
    part: { fontSize: 18, bold: true, margin: [0, 14, 0, 6] },
    artifact: { fontSize: 14, bold: true, margin: [0, 10, 0, 4] },
    h1: { fontSize: 16, bold: true, margin: [0, 8, 0, 4] },
    h2: { fontSize: 14, bold: true, margin: [0, 8, 0, 4] },
    h3: { fontSize: 12, bold: true, margin: [0, 6, 0, 3] },
    kicker: { fontSize: 8, color: ACCENT, characterSpacing: 1 },
    label: { fontSize: 10 },
    muted: { fontSize: 10, color: '#555555' },
    code: { font: 'Roboto', fontSize: 9, background: '#f3f3f3' },
    readAloud: { fontSize: 11, italics: true, fillColor: '#f6efe2' },
  };

  return {
    content,
    styles,
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.35 },
    footer: (currentPage): Content => ({
      text: `${deliverable.title} · ${currentPage}`,
      alignment: 'center',
      style: 'muted',
    }),
  };
}

/** Loads all images referenced by the deliverable (cover + artifact covers). */
async function loadModuleImages(
  deliverable: Deliverable,
  artifacts: readonly AnyArtifact[],
): Promise<ModulePdfImages> {
  const ids = new Set<string>();
  if (deliverable.coverImageId !== null) ids.add(deliverable.coverImageId);
  const byId = new Map(artifacts.map((entry) => [entry.id, entry]));
  const visit = (nodes: readonly OutlineNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'chapter' || node.type === 'part') visit(node.children);
      else if (node.type === 'artifact') {
        const artifact = byId.get(node.artifactId);
        if (artifact?.coverImageId != null) {
          ids.add(artifact.coverImageId);
        }
      }
    }
  };
  visit(deliverable.outline);
  const images: Record<string, string> = {};
  for (const id of ids) {
    const stored = await getImage(id);
    if (stored === undefined) continue;
    try {
      const { dataUrl } = await blobToScaledDataUrl(
        new Blob([stored.bytes]), // bytes are clone-safe Uint8Array
        1024,
      );
      images[id] = dataUrl;
    } catch {
      // A broken image must never fail the build.
    }
  }
  return images;
}

/** Builds the module PDF blob; pdfmake is loaded lazily by pdfExport's helper. */
export async function buildModulePdf(
  deliverable: Deliverable,
  artifacts: readonly AnyArtifact[],
  generate: (definition: TDocumentDefinitions) => Promise<Blob>,
): Promise<Blob> {
  const images = await loadModuleImages(deliverable, artifacts);
  const definition = buildModuleDefinition(deliverable, artifacts, images);
  return generate(definition);
}

/** Resolved monsters for an encounter artifact (used by the builder UI preview). */
export async function resolveEncounterMonsters(
  artifact: AnyArtifact,
): Promise<{ name: string; count: number; origin: string }[]> {
  if (artifact.kind !== 'encounter') return [];
  const resolved = await resolveMonsterEntries(artifact.data.monsters);
  return artifact.data.monsters.map((monster, index) => ({
    name: monster.name,
    count: monster.count,
    origin: resolved[index]?.origin ?? '',
  }));
}
