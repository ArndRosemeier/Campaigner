import type { AnyArtifact, Id, LiveMonsterEntry, MonsterEntry, Rulebook, RuleChunk, StatBlock } from '@/domain';
import { creatureRefIsEmpty } from '@/domain/creature';

/**
 * Monster source resolution (07-MILESTONE-3 M3-B; re-based on the library tier
 * by the owner-ratified core-mob arc, docs/11 D5 amendment). Turns an
 * encounter's monster entry into a displayable StatBlock + origin label. Pure
 * logic — lookups are injected so the domain never touches Dexie; `src/db/
 * monsterResolve.ts` wires the repo-backed variant used by the UI.
 *
 * A creature citation names a LIBRARY row, never a campaign artifact, so the
 * only way it can fail is that the library genuinely lacks the row (docs/11
 * D9). Deleting every campaign artifact and every module cannot produce a
 * `missing ref` here, because no citation names a campaign row — that is the
 * property the arc exists for, and it is pinned by test.
 *
 * Content-identity fallback (chunk-hash-fallback arc): a citation whose uuid
 * misses but carries `contentHash` resolves through `getChunkByContentHash` —
 * a re-ingest under a new row id still satisfies a byte-identical citation.
 * Exact content-hash ONLY: a same-creature chunk under a new hash stays
 * 'missing ref' (the import dep dialog already reports that drift). The
 * fallback is tried BEFORE the citation is declared missing, everywhere,
 * including the derived-stats path below.
 */

/**
 * WHAT a `missing ref` origin is made of, structurally — the companion of the
 * display label, composed with it by `missingRefReason` so the two cannot
 * disagree. A surface that must NAME what is missing (the campaign banner,
 * docs/17 row 155) reads a field instead of parsing `missing ref (Zombie)`,
 * which no label format could survive.
 */
export interface MissingRef {
  /**
   * The creature the reason names — the same name the label prints inside its
   * parentheses, TRIMMED. `''` is the honest "this citation records no
   * creature": the resolver's name falls back to the roster entry's own, which
   * a hand-written row can leave empty. Never a placeholder for one.
   */
  creature: string;
  /**
   * The BOOK the citation was written from — the title stamped at citation
   * birth (`contentIdentityFor`'s `bookTitle`, the SAME title
   * `creatureOriginLabel` prints, docs/12 §8). Absent when the citation
   * records none: one written before the stamp existed, or a library row with
   * no title. Nothing is known then, and a surface that must name the pack
   * says so instead of guessing one from the creature's name (AGENTS rule 1).
   */
  bookTitle?: string | undefined;
}

export interface MonsterLookups {
  /** Any scope: an encounter may cite a library-published NPC too, so the
   * lookup is the artifact repo's widest read. */
  getArtifact: (id: Id) => Promise<AnyArtifact | undefined>;
  getChunk: (id: Id) => Promise<RuleChunk | undefined>;
  /** Content-identity fallback for uuid-mismatched installs (exact hash only). */
  getChunkByContentHash: (contentHash: string) => Promise<RuleChunk | undefined>;
  /** The book a chunk belongs to — drives the origin label (12-BESTIARY-PACKS §8). */
  getRulebook: (bookId: Id) => Promise<Rulebook | undefined>;
}

export interface ResolvedMonster {
  statBlock: StatBlock | null;
  /**
   * Display string: "NPC: Vexra" / "NPC: Aunt Agatha (zombie stats from
   * Monster Manual p.316)" / "Bestiary p.132" / "Bestiary: Zombie" / "inline" /
   * "missing ref" / "missing ref (Zombie)" / "" (none).
   */
  origin: string;
  /**
   * Present ⇔ `origin` is the missing-ref reason (`isMissingRefOrigin`): the
   * STRUCTURED half of the same fact, built with the label by
   * `missingRefReason`. A surface that must list what is missing reads this —
   * never the label's text.
   */
  missingRef?: MissingRef | undefined;
}

/**
 * A LIBRARY CREATURE CITATION as written on a roster entry or on an authored
 * NPC's `creatureRef` (docs/11 D3): the chunk uuid, the content hash stamped
 * at citation birth, the creature's own name and the BOOK it came from where
 * one is known. Both citation sites spell it the same way, which is why the
 * resolver below is ONE function — a second resolution order would be a second
 * answer to "which numbers is this creature?".
 */
export interface CreatureCitation {
  chunkId?: string | undefined;
  contentHash?: string | undefined;
  creatureName?: string | undefined;
  /**
   * The book the cited chunk came from, as its row's own title, stamped at
   * citation birth (docs/17 row 155). NOT a resolution key — resolution is the
   * uuid, then the exact content hash (above) — it is the identity a report of
   * a STRANDED citation names, so a GM is told which pack to install instead
   * of only how many refs dangle.
   */
  bookTitle?: string | undefined;
}

/**
 * Content identity stamped at citation birth (chunk-hash-fallback arc; the
 * book half added by docs/17 row 155): the cited chunk's SHA-256, the creature
 * name (`headingPath[0]`, roster entry-name fallback — the same fallback
 * `collectDependencies` uses for its manifest `creatureName`) and the title of
 * the book the chunk came from. Shared by EVERY citation writer (runEngine
 * finalize, the editor dialog, the spawn picker, the module generator's cast)
 * so all births agree.
 *
 * `bookTitle` is additive and OPTIONAL, and an unknown one is OMITTED rather
 * than stored empty: an empty string standing in for a book would be the
 * placeholder AGENTS rule 1 forbids, and a surface that must name the pack has
 * to be able to tell "not recorded" from a real title.
 */
export function contentIdentityFor(
  contentHash: string,
  creatureHeading: string | undefined,
  entryName: string,
  bookTitle?: string,
): { contentHash: string; creatureName: string; bookTitle?: string | undefined } {
  const heading = creatureHeading?.trim();
  const book = bookTitle?.trim();
  return {
    contentHash,
    creatureName: heading === undefined || heading === '' ? entryName : heading,
    ...(book === undefined || book === '' ? {} : { bookTitle: book }),
  };
}

/**
 * The title a citation STAMPS for a book row — `undefined` when there is no
 * book, or its title is blank: nothing is known then, and the honest stamp is
 * no stamp. THE one stamping read of "which book is this chunk's".
 */
export function citationBookTitle(book: Rulebook | undefined): string | undefined {
  const title = book?.title.trim() ?? '';
  return title === '' ? undefined : title;
}

/**
 * The title an origin LABEL prints for a book row — the row's own title, or
 * the `Rulebook` stand-in when there is no row (or its title is blank). A
 * LABEL always has to print something; a STAMP must not (`citationBookTitle`
 * above), which is the whole difference between the two. THE one label read,
 * so `creatureOriginLabel` and every other surface that names a book's title
 * for a reader cannot drift.
 */
export function rulebookDisplayTitle(book: Rulebook | undefined): string {
  return book?.title === undefined || book.title === '' ? 'Rulebook' : book.title;
}

/**
 * Resolves a library creature CITATION to the chunk row that answers it — uuid
 * first (the cited instance); on a miss, the stamped content hash falls back to
 * whatever local chunk carries the identical bytes (a re-ingest under a new row
 * id). `undefined` means the library genuinely lacks the creature: the ONE
 * surviving failure mode (docs/11 D9).
 *
 * THE one resolution order. `resolveMonsterEntry` calls it for a `rulebook`
 * citation AND for an authored NPC's derived stat block, so an Aunt Agatha and
 * a cited zombie can never resolve differently.
 */
export async function resolveCreatureChunk(
  citation: CreatureCitation,
  lookups: Pick<MonsterLookups, 'getChunk' | 'getChunkByContentHash'>,
): Promise<RuleChunk | undefined> {
  const byId = citation.chunkId === undefined ? undefined : await lookups.getChunk(citation.chunkId);
  if (byId !== undefined) return byId;
  if (citation.contentHash === undefined) return undefined;
  return lookups.getChunkByContentHash(citation.contentHash);
}

/** The creature's display name for a citation: the stamped creature name, else
 * the caller's fallback (the roster entry / NPC name). */
export function creatureCitationName(citation: CreatureCitation, fallback: string): string {
  const named = citation.creatureName?.trim();
  return named === undefined || named === '' ? fallback : named;
}

/**
 * The origin label of a resolved LIBRARY CREATURE — what the number's source
 * IS, with no authored-NPC prefix. Shared by a `rulebook` citation (which
 * renders it verbatim) and by the derived path (which wraps it, see
 * `derivedStatOrigin`).
 */
export async function creatureOriginLabel(
  chunk: RuleChunk,
  citationName: string,
  lookups: Pick<MonsterLookups, 'getRulebook'>,
): Promise<string> {
  const book = await lookups.getRulebook(chunk.bookId);
  const title = rulebookDisplayTitle(book);
  // Pack chunks have no page numbers (12-BESTIARY-PACKS §4/§8): the label
  // names the creature instead. PDF books keep the page label.
  if (book?.origin === 'pack') {
    const creature = chunk.headingPath[0]?.trim();
    return `${title}: ${creature === undefined || creature === '' ? citationName : creature}`;
  }
  return `${title} p.${chunk.pageStart}`;
}

/**
 * The origin label of an AUTHORED NPC whose stat block is DERIVED from a
 * library creature (docs/11 D3). It LEADS with the NPC's own name — the row
 * the GM opened — and DISCLOSES the derivation, so nobody can mistake these
 * numbers for the NPC's own authored block. Pinned verbatim by test.
 */
export function derivedStatOrigin(npcName: string, creatureOrigin: string): string {
  return `NPC: ${npcName} (stats from ${creatureOrigin})`;
}

/**
 * THE one missing-ref reason: the display label AND the structured identity
 * behind it, built TOGETHER so a caller can never hold one without the other.
 * The cited creature's own name rides along when the citation stamped one — a
 * bare "missing ref" tells a GM nothing about WHAT is missing — and the book
 * the citation was written from rides along when it recorded one, which is
 * what lets the campaign banner name the pack to install.
 */
export function missingRefReason(
  citationName: string,
  bookTitle?: string,
): { origin: string; missingRef: MissingRef } {
  const creature = citationName.trim();
  const book = bookTitle?.trim();
  return {
    origin: creature === '' ? 'missing ref' : `missing ref (${creature})`,
    missingRef: {
      creature,
      ...(book === undefined || book === '' ? {} : { bookTitle: book }),
    },
  };
}

/** The `missing ref` LABEL alone, for the callers that print one and carry no
 * resolution (`rosterReferenceFor`'s dangling `npc-ref`): the display half of
 * the ONE reason above. */
export function missingCreatureOrigin(citationName: string): string {
  return missingRefReason(citationName).origin;
}

/**
 * Whether an origin is the missing-ref reason. THE one test every surface uses:
 * the reason is NAMED (`missing ref (Zombie)`), so a `=== 'missing ref'`
 * comparison silently never matches — a bug this predicate exists to make
 * unrepresentable (docs/18 §4).
 */
export function isMissingRefOrigin(origin: string): boolean {
  return origin.startsWith('missing ref');
}

/** One library creature citation resolved end to end: the stats plus the
 * disclosed origin (and, when nothing answered it, the structured reason).
 * `undefined` chunk ⇒ `missing ref` (the ONE failure mode). */
export interface ResolvedCreature {
  statBlock: StatBlock | null;
  origin: string;
  /** Present ⇔ `origin` is the missing-ref reason — see `ResolvedMonster`. */
  missingRef?: MissingRef | undefined;
}

/**
 * The ONE library-creature read: citation → chunk → stats + origin label.
 * Every creature-stat reader in the app goes through this or through
 * `resolveMonsterEntry` below (which delegates here for its citation case), so
 * "which numbers, from where" has exactly one answer.
 */
export async function resolveCreatureCitation(
  citation: CreatureCitation,
  citationName: string,
  lookups: MonsterLookups,
): Promise<ResolvedCreature> {
  const chunk = await resolveCreatureChunk(citation, lookups);
  if (chunk?.statBlock == null) {
    return { statBlock: null, ...missingRefReason(citationName, citation.bookTitle) };
  }
  return {
    statBlock: chunk.statBlock,
    origin: await creatureOriginLabel(chunk, citationName, lookups),
  };
}

/**
 * The numbers of an AUTHORED NPC that BORROWS them from a library creature
 * (docs/11 D3, the owner's Aunt Agatha path: *"she will have zombie stats but
 * with prose"*). `npcName` is the row's OWN name — the identity a reader
 * opened — and the label LEADS with it, so borrowed numbers are never taken
 * for an authored block.
 *
 * THE one derived-stats rule. The encounter roster's `npc-ref` arm below and
 * `db/creatureRepo.resolveDerivedNpcStats` (the repo-wired read every UI
 * surface asks) both go through THIS, so a row's details panel, an encounter
 * listing that row and a battle token can never answer "which numbers are
 * this npc's?" differently.
 *
 * TWO ways it fails, both NAMED: a citation that carries neither key at all is
 * a dead pointer and an ERROR (`creatureRefIsEmpty` — calling it "missing"
 * would hide a write-side bug behind a read-side label, which is the same
 * refusal the repo-level citation resolver makes), and a citation the library
 * cannot supply answers the one shared `missing ref (<the creature>)` label —
 * the citation's own stamped creature name, never the row's title, because a
 * reader has to be told WHAT is missing.
 */
export async function resolveDerivedNpcStats(
  npcName: string,
  citation: CreatureCitation,
  lookups: MonsterLookups,
): Promise<ResolvedCreature> {
  if (creatureRefIsEmpty(citation)) {
    throw new Error(
      `creature citation for "${npcName}" carries neither a chunk id nor a content hash — nothing can resolve it`,
    );
  }
  const creature = await resolveCreatureCitation(
    citation,
    creatureCitationName(citation, npcName),
    lookups,
  );
  if (creature.statBlock === null) return creature;
  return {
    statBlock: creature.statBlock,
    origin: derivedStatOrigin(npcName, creature.origin),
  };
}

/**
 * The CROSS-REFERENCE a roster entry's reference may need: the row it names and
 * the pdfmake destination that row prints at. A `npc-ref` reference is a `see
 * <name>` link when the document prints that row (pdfmake throws on a
 * destination that does not exist) and plain text when it does not, so the
 * caller is handed the NAME plus the optional destination rather than a
 * pre-linked run.
 */
export interface MonsterReferenceLink {
  name: string;
  destination: string;
}

/**
 * What a document PRINTS as a roster row's reference (docs/17 row 144): the
 * addressable text, plus — for a `npc-ref` — the row to cross-reference. An
 * EMPTY `text` means the row needs no reference at all (an `inline` entry
 * carries its own numbers).
 *
 * ONE formatter for every surface that prints a roster reference — the module
 * PDF and the single-artifact GM export both render THIS, so the two books
 * cannot label the same entry differently (AGENTS rule 4). It is driven by the
 * `resolved` origin the async pre-pass already produces: the true origin of a
 * `rulebook` citation (`Bestiary p.132`), the named missing-ref reason, the
 * cross-reference of an `npc-ref`, and the no-citation statement of `none`.
 * Nothing here writes anything and nothing is materialized: the numbers stay the
 * cited library chunk's own (docs/12 §Storage, docs/11 D2/D3).
 */
export interface MonsterReference {
  /** The reference text as a caller sets it off, with NO separator. */
  text: string;
  /**
   * `text` AS ONE PRINTED LINE, separator included (`Zombie ×4` +
   * `printed` = `Zombie ×4 — Bestiary p.132`), and `''` for a row that prints
   * no reference. THE string a caller renders when it prints a plain line, so a
   * link run and a plain run can never disagree about the visible words.
   */
  printed: string;
  /** Present only for an `npc-ref` whose row the document prints (clickable). */
  link?: MonsterReferenceLink;
}

/** An `inline` entry carries its own stat block: no reference line at all. */
const NO_REFERENCE: MonsterReference = { text: '', printed: '' };
/** The separator between a roster line and its reference. */
const REFERENCE_SEPARATOR = ' — ';
const NO_CITATION_REFERENCE = 'no stats: this roster entry names the creature without a citation';
/**
 * A citation the pre-pass did not resolve — reachable only when a builder is
 * called WITHOUT resolution data (no production path does). It never falls back
 * to a citation-shaped claim the document cannot honour (AGENTS rule 1): the
 * document says the citation could not be resolved, in the same named register
 * as the missing-ref reason.
 */
const UNRESOLVED_CITATION_REFERENCE = 'unresolved citation: this build resolved no origin for it';

/** A plain reference: the text, plus the same text as one printed line. */
function plainReference(text: string): MonsterReference {
  return { text, printed: `${REFERENCE_SEPARATOR}${text}` };
}

/**
 * WHAT a roster row's reference is, and what a cited mob prints — the ONE rule
 * every roster-printing surface goes through (docs/17 row 144).
 *
 * It is driven by the `resolved` origin the async pre-pass already produces: the
 * TRUE origin of a `rulebook` citation (`Bestiary p.132`), the named missing-ref
 * reason of a citation nothing can satisfy, the `see <name>` cross-reference of
 * an `npc-ref`, and the no-citation statement of a name-only entry. An `inline`
 * entry gets NO reference at all, because its own stat box prints underneath.
 *
 * `printed` is the string a caller renders for a plain line and `link` the row a
 * caller links to; both are composed HERE, so the module PDF and the
 * single-artifact GM export cannot label one entry differently (AGENTS rule 4).
 * Nothing is written and nothing is materialized: the numbers stay the cited
 * library chunk's own (docs/12 §Storage, docs/11 D2/D3).
 */
export function rosterReferenceFor(
  entry: MonsterEntry,
  resolved: ResolvedMonster | undefined,
  target?: MonsterReferenceLink,
): MonsterReference {
  // A citation nothing can satisfy: the NAMED reason, through the ONE
  // predicate — never a `=== 'missing ref'` comparison, which silently never
  // matches because the reason carries the creature's name.
  if (resolved !== undefined && isMissingRefOrigin(resolved.origin)) {
    return plainReference(resolved.origin);
  }
  // A mob COPY carries its own stamped origin line (docs/17 row 248): the
  // migration resolved it from the live chunk+book read before dropping the
  // citation, so an `inline` copy must PRINT it — that arm used to print
  // nothing, which would silently drop "Bestiary p.132" from every converted
  // mob. An authored inline block has no stamp and keeps printing nothing.
  const stamped = entry.sourceLine?.trim();
  if (stamped !== undefined && stamped !== '') return plainReference(stamped);
  switch (entry.source.type) {
    case 'inline':
      // The stat box prints immediately below: an origin run here would
      // contradict the block under it.
      return NO_REFERENCE;
    case 'npc-ref':
      if (target === undefined) {
        // No row and no resolution: the reference genuinely dangles.
        return plainReference(missingCreatureOrigin(entry.name));
      }
      return { ...plainReference(`see ${target.name}`), link: target };
    case 'rulebook':
      // The REAL origin of the cited creature — the book and page the numbers
      // actually come from. The pre-pass resolves it for every row it runs
      // over, so the constant `(see Bestiary)` this used to print pointed at a
      // chapter no module PDF has ever had (docs/17 row 108 superseded by 142,
      // which amends row 108 by reference).
      return resolved === undefined
        ? plainReference(UNRESOLVED_CITATION_REFERENCE)
        : plainReference(resolved.origin);
    case 'none':
      // A name-only roster entry records no citation at all. The resolution
      // pass reports the named missing-ref reason for it (the branch above);
      // with no resolution available this states what is actually true about
      // the row, instead of the shipped renderer's bare "name ×count".
      return plainReference(NO_CITATION_REFERENCE);
  }
}

/**
 * The stat block a roster row PRINTS: the cited library creature's resolved
 * numbers for a `rulebook` citation, the entry's own block for `inline`.
 *
 * THE one rule for "does this row print a box, and whose numbers are they",
 * read by both exporters. A citation the library cannot satisfy resolves to
 * `null` (the chunk is absent, or its ingest left no parseable `statBlock`), and
 * that case prints NO box — the named missing-ref reference line stands alone
 * rather than an empty or invented one (AGENTS rule 1). A `rulebook` entry with
 * NO resolution at all likewise prints no box: an unresolved citation must not
 * silently become a heading with nothing under it.
 */
export function rosterStatBlockFor(
  entry: MonsterEntry,
  resolved: ResolvedMonster | undefined,
): StatBlock | null {
  switch (entry.source.type) {
    case 'inline':
      return entry.source.statBlock;
    case 'rulebook':
      return resolved?.statBlock ?? null;
    case 'npc-ref':
    case 'none':
      return null;
  }
}

/** What ONE roster entry carries, and the ONE line a roster row prints for it. */
export interface MonsterTreasure {
  /**
   * The authored items, TRIMMED — what a caller that names the carrier itself
   * puts in its own cell (the ledger's `Treasure` column), never re-joined with
   * anything.
   */
  text: string;
  /** `text` AS ONE LABELLED LINE — the string a roster row renders. */
  printed: string;
}

/** The label a roster row prints its carried items under. */
const TREASURE_LABEL = 'Treasure: ';

/**
 * WHAT a roster row's TREASURE is — the ONE rule every treasure-printing surface
 * goes through (docs/17 row 159, docs/11 §What a roster row PRINTS).
 *
 * The encounter's roster entry owns the text (`MonsterEntry.treasure`: what ONE
 * instance of that entry carries, one item per line, `''` when it carries
 * nothing), and the answer is either that text or `null`. `null` is the whole
 * emptiness rule: a caller that gets it prints NOTHING — no line, no label with
 * a blank value, no ledger row — so "does this mob carry anything" is decided in
 * exactly one place and the module PDF, the single-artifact GM export, the
 * reader's roster row and the document's treasure ledger cannot disagree about
 * it. `printed` carries the label, so no caller composes one of its own.
 *
 * Nothing is written and nothing is materialized: the mob's own authored text is
 * what every surface renders, and the treasure is never merged with the
 * encounter-level `treasure` field, which stays a line of its own.
 */
export function rosterTreasureFor(entry: MonsterEntry): MonsterTreasure | null {
  const text = entry.treasure.trim();
  if (text === '') return null;
  return { text, printed: `${TREASURE_LABEL}${text}` };
}

/**
 * Resolve a LIVE roster entry — the two representations the model has left
 * (docs/17 row 248): an authored COPY (or authored block), and a name-only
 * entry. This function deliberately carries NO legacy arm: a stored legacy
 * pointer is read and resolved by the ONE seam
 * `domain/mobCopyLegacy.resolveStoredMonsterEntry`, which `db/monsterResolve`
 * dispatches through. Handing this function a legacy entry is a programming
 * error the narrowed `LiveMonsterEntry` type makes unrepresentable rather than
 * a silent wrong answer (AGENTS rule 1).
 */
export function resolveMonsterEntry(entry: LiveMonsterEntry): ResolvedMonster {
  // The entry's own STAMPED origin line, when it is a migrated copy (docs/17
  // row 248) — read once, so the inline arm below and every other reader of
  // this entry agree about what it says.
  const stamped = entry.sourceLine?.trim();
  switch (entry.source.type) {
    case 'inline':
      // The stat box prints immediately below: an origin run here would
      // contradict the block under it. A migrated COPY is the exception — it
      // carries a stamped `sourceLine` and no citation left to compose one
      // from, so the origin IS that stored line (docs/17 row 248).
      return {
        statBlock: entry.source.statBlock,
        origin: stamped === undefined || stamped === '' ? 'inline' : stamped,
      };
    case 'none':
      return { statBlock: null, origin: '' };
  }
}
