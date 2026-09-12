import type { Transaction } from 'dexie';

import type { CreatureCitationRepairReport, MonsterEntry } from '@/domain';

/**
 * THE one loud, idempotent citation repair (docs/11 D7) — the seam that heals
 * the owner's incident and the rows the old model left behind.
 *
 * Background (docs/17 row 106): a bestiary creature used to be represented by a
 * hidden `npc` artifact carrying `data.monsterChunkId`. A roster entry citing
 * it was an `npc-ref` to that row — so adopting and then DELETING two such rows
 * left two roster entries on a permanent `missing ref`. The marker WAS the
 * creature's identity, so the repair is lossless: every such citation is
 * rewritten to the `rulebook` citation of that identity, which is exactly the
 * form the new model resolves by (docs/11 D2/D5).
 *
 * Three jobs, in order, in ONE transaction:
 *
 * 1. REWRITE every `npc-ref` whose target carried the old marker into the
 *    `rulebook` citation of that identity. The content hash is read from the
 *    library row the marker names, so the rewritten citation keeps the
 *    content-hash fallback every other citation has.
 * 2. The citations that could NOT be converted are reported BY NAME with their
 *    reason — never left to render as a bare `missing ref` (AGENTS rule 1).
 * 3. The marked rows are deleted as cache (they were never authored content),
 *    AFTER their covers have been carried onto the campaign's presentation row
 *    for the creature identity, so no portrait dies with the row. A marked row
 *    that still carried authored text is reported by name too: it was cache,
 *    but the owner may want that text back as a real NPC.
 *
 * IDEMPOTENT: a second run finds `isMobArtifact` rows only if a first run's
 * work was rolled back (the whole thing is ONE transaction, so it either
 * happens or does not), and a row without the marker is left untouched. The
 * test that runs it twice pins this directly.
 *
 * The function takes the TRANSACTION, not the `db` singleton: the Dexie
 * `version(20)` upgrade body runs before the upgraded `db` instance is usable,
 * and a nested `db.transaction` there fails. It is exported separately so the
 * idempotency pin can call it directly, in an ordinary transaction, without
 * reopening the database at another version.
 */

/** The rows this repair is allowed to touch, by the marker the retired model
 * wrote. Read here as raw values: the ARTIFACT SCHEMA no longer has the field
 * (docs/11 D1), so a marked row no longer parses as an artifact — which is
 * precisely why it has to be converted rather than read. */
interface LegacyMarkedRow {
  id: string;
  campaignId: string | null;
  moduleId: string | null;
  kind: string;
  name: string;
  summary?: unknown;
  body?: unknown;
  coverImageId?: unknown;
  data?: { monsterChunkId?: unknown; appearance?: unknown; personality?: unknown } | undefined;
}

function markedChunkId(row: LegacyMarkedRow): string | null {
  const value = row.data?.monsterChunkId;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A citation that now names a library creature instead of a campaign row. */
interface RulebookCitation {
  type: 'rulebook';
  chunkId: string;
  contentHash?: string;
  creatureName?: string;
}

export interface RepairCreatureCitationsOptions {
  /** The Dexie upgrade transaction (or an ordinary one in tests). */
  tx: Transaction;
}

export async function repairCreatureCitations(
  options: RepairCreatureCitationsOptions,
): Promise<CreatureCitationRepairReport> {
  const artifacts = options.tx.table('artifacts');
  const chunks = options.tx.table('chunks');
  const images = options.tx.table('images');
  const presentation = options.tx.table('creatureImages');
  const settings = options.tx.table('settings');

  const report: CreatureCitationRepairReport = {
    citationsRewritten: 0,
    emptyRowsDeleted: 0,
    coversCarriedForward: 0,
    authoredRowsRemoved: [],
    unconverted: [],
  };

  const all = (await artifacts.toArray()) as unknown[];
  const marked = new Map<string, LegacyMarkedRow>();
  for (const raw of all) {
    const row = raw as LegacyMarkedRow;
    if (row.kind !== 'npc') continue;
    const chunkId = markedChunkId(row);
    if (chunkId === null) continue;
    marked.set(row.id, row);
  }
  if (marked.size === 0) return report;

  /** Each marked row's identity, and the library row it names (for the
   * content hash the rewritten citation must carry). */
  const identityOf = new Map<string, RulebookCitation>();
  for (const [artifactId, row] of marked) {
    const chunkId = markedChunkId(row);
    if (chunkId === null) continue;
    const chunk = (await chunks.get(chunkId)) as { contentHash?: unknown; headingPath?: unknown } | undefined;
    if (chunk === undefined) {
      // The identity is still known (the marker names the chunk); the citation
      // is written WITHOUT a content hash — the uuid is what it has. Reported
      // below only if a citation is actually lost.
      identityOf.set(artifactId, { type: 'rulebook', chunkId });
      continue;
    }
    const contentHash = typeof chunk.contentHash === 'string' ? chunk.contentHash : undefined;
    const headingPath = Array.isArray(chunk.headingPath) ? chunk.headingPath : [];
    const creature = headingPath.length > 0 ? String(headingPath[0] ?? '').trim() : '';
    identityOf.set(artifactId, {
      type: 'rulebook',
      chunkId,
      ...(contentHash === undefined ? {} : { contentHash }),
      ...(creature === '' ? {} : { creatureName: creature }),
    });
  }

  /** Campaigns whose citations were rewritten, so the cover carry-forward
   * knows which presentation rows to seed. */
  const campaignsByArtifact = new Map<string, Set<string>>();

  for (const raw of all) {
    const row = raw as Record<string, unknown>;
    if (row.kind !== 'encounter') continue;
    const data = row.data as { monsters?: unknown } | undefined;
    if (data === undefined || !Array.isArray(data.monsters)) continue;
    const campaignId = typeof row.campaignId === 'string' ? row.campaignId : null;
    let changed = false;
    const monsters: unknown[] = [];
    for (const entryRaw of data.monsters as unknown[]) {
      const entry = entryRaw as MonsterEntry & { source?: { type?: unknown; artifactId?: unknown } };
      const source = entry.source;
      if (source.type !== 'npc-ref' || typeof source.artifactId !== 'string') {
        monsters.push(entryRaw);
        continue;
      }
      if (!marked.has(source.artifactId)) {
        monsters.push(entryRaw);
        continue;
      }
      const identity = identityOf.get(source.artifactId);
      if (identity === undefined) {
        // Unreachable (only marked ids reach here and every marked id has an
        // identity), but reported rather than dropped if it ever happens.
        report.unconverted.push({
          where: `the encounter "${String(row.name ?? row.id)}"`,
          name: entry.name,
          reason: 'the retired creature row carried no usable identity',
        });
        monsters.push(entryRaw);
        continue;
      }
      if (campaignId !== null) {
        const set = campaignsByArtifact.get(source.artifactId) ?? new Set<string>();
        set.add(campaignId);
        campaignsByArtifact.set(source.artifactId, set);
      }
      report.citationsRewritten += 1;
      changed = true;
      monsters.push({ ...entry, source: identity });
    }
    if (!changed) continue;
    await artifacts.put({ ...row, data: { ...data, monsters } });
  }

  // A REWRITTEN citation is only a repair if the library can satisfy it: the
  // marker named a chunk, and if that chunk is not in this workspace the
  // citation would render 'missing ref' with no explanation of WHICH creature
  // is missing. Named here, by the creature's own name (AGENTS rule 1).
  const lost = new Set<string>();
  for (const entry of [...campaignsByArtifact.keys()]) {
    const row = marked.get(entry);
    if (row === undefined) continue;
    const chunkId = markedChunkId(row);
    if (chunkId === null || lost.has(chunkId)) continue;
    if ((await chunks.get(chunkId)) !== undefined) continue;
    lost.add(chunkId);
    report.unconverted.push({
      where: 'a rewritten creature citation',
      name: row.name,
      reason: `the cited stat-block chunk ${chunkId} is not in this workspace — install the pack or re-import the book that carries it`,
    });
  }

  // Cover carry-forward BEFORE the delete: a portrait generated for a creature
  // must not die with the row that used to hold it (docs/11 D5 preservation
  // rule). The campaign's PRESENTATION row receives the bytes — the same
  // mechanism the portrait queue uses, so there is one place a creature's look
  // can live.
  for (const [artifactId, row] of marked) {
    const coverImageId = typeof row.coverImageId === 'string' ? row.coverImageId : null;
    if (coverImageId === null) continue;
    const identity = identityOf.get(artifactId);
    if (identity === undefined) continue;
    const source = (await images.get(coverImageId)) as { bytes?: unknown; mimeType?: unknown; width?: unknown; height?: unknown; prompt?: unknown; model?: unknown } | undefined;
    if (source === undefined) continue;
    const campaigns = campaignsByArtifact.get(artifactId) ?? new Set<string>();
    for (const campaignId of campaigns) {
      const creatureKey = `chunk:${identity.chunkId}`;
      const rows = (await presentation.toArray()) as {
        campaignId?: unknown;
        creatureKey?: unknown;
      }[];
      const existing = rows.find(
        (rowRaw) => rowRaw.campaignId === campaignId && rowRaw.creatureKey === creatureKey,
      );
      if (existing !== undefined) continue;
      const imageId = crypto.randomUUID();
      const now = Date.now();
      await images.put({
        id: imageId,
        createdAt: now,
        updatedAt: now,
        campaignId,
        bytes: source.bytes,
        mimeType: source.mimeType,
        width: source.width,
        height: source.height,
        prompt: source.prompt,
        model: source.model,
        source: 'generated',
        role: 'artwork',
      });
      await presentation.put({
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        campaignId,
        creatureKey,
        imageId,
      });
      report.coversCarriedForward += 1;
    }
  }

  // The rows themselves: cache, never authored content. Reported by name when
  // they carried authored text, because that text is what the owner may want.
  for (const row of marked.values()) {
    const authored = authoredTextOf(row);
    if (authored.length > 0) {
      report.authoredRowsRemoved.push(`${row.name} (${authored.join(', ')})`);
    }
    await artifacts.delete(row.id);
    report.emptyRowsDeleted += 1;
  }

  const existingSettings = (await settings.get('settings')) as Record<string, unknown> | undefined;
  const repairedSomething =
    report.citationsRewritten > 0 ||
    report.emptyRowsDeleted > 0 ||
    report.coversCarriedForward > 0 ||
    report.unconverted.length > 0 ||
    report.authoredRowsRemoved.length > 0;
  if (existingSettings === undefined) {
    // No settings row and yet there was creature state to repair means the
    // report has nowhere to be READ. Losing it would be the one thing D7
    // forbids (a silent repair), so the transaction fails loudly instead: an
    // unreportable migration is worse than no migration (AGENTS rule 1).
    if (repairedSomething) {
      throw new Error(
        'creature citation repair: this workspace has retired creature rows but no settings row to report the outcome in — refusing to migrate silently',
      );
    }
    return report;
  }
  await settings.put({ ...existingSettings, creatureCitationRepair: report, updatedAt: Date.now() });
  return report;
}

/** The authored text a retired creature row carried, for the by-name report.
 * Every field here is text a GM would miss; there is no other reason to keep
 * the row alive (its stats always lived in the chunk). */
function authoredTextOf(row: LegacyMarkedRow): string[] {
  const fields: string[] = [];
  const text = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
  const summary = (row as { summary?: unknown }).summary;
  const body = (row as { body?: unknown }).body;
  if (text(summary)) fields.push('summary');
  if (text(body)) fields.push('body');
  if (text(row.data?.appearance)) fields.push('appearance');
  if (text(row.data?.personality)) fields.push('personality');
  return fields;
}

/** The retired model's marker read, exported for the repair's own tests (the
 * artifact schema no longer has the field). */
export function isRetiredCreatureRow(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const value = row as LegacyMarkedRow;
  return value.kind === 'npc' && markedChunkId(value) !== null;
}

/** The roster citation shape the repair writes, for tests that assert the
 * rewrite rather than re-implementing it. */
export type { RulebookCitation };
