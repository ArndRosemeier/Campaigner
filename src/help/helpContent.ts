/**
 * Single source of truth for in-app help (all screens). Every help topic is
 * plain data: the HelpDialog renders it, the contextual HelpButton opens it,
 * and a test guarantees every topic stays complete.
 */

export type HelpTopic =
  | 'start'
  | 'campaigns'
  | 'tree'
  | 'editor'
  | 'assistant'
  | 'writers-room'
  | 'module'
  | 'runs'
  | 'rules'
  | 'search'
  | 'embeddings'
  | 'graph'
  | 'settings'
  | 'shortcuts';

export interface HelpEntry {
  title: string;
  /** One-line "what is this surface" answer. */
  summary: string;
  /** Concrete things you can do here, including hidden affordances. */
  tips: string[];
  /** Extra search keywords (not shown). */
  keywords?: string;
}

export const HELP_CONTENT: Record<HelpTopic, HelpEntry> = {
  start: {
    title: 'Welcome & quick start',
    summary:
      'Campaigner is a local-first campaign writing workbench: rulebooks, artifacts, AI personas and exports — no backend, everything stays in this browser.',
    tips: [
      'Typical flow: set your OpenRouter key in Settings → import a rulebook in Rules → create a campaign → write artifacts yourself or with personas.',
      'Rule text can be pinned from Rules search and is then offered to every persona run as grounding context.',
      'Everything is exportable: single artifacts, a selection, whole campaigns (JSON/zip), and PDFs (GM notes or player handouts).',
      'Stuck? Every screen has a small ? button in its header that opens help for exactly that surface.',
    ],
    keywords: 'overview introduction getting started',
  },
  campaigns: {
    title: 'Campaigns',
    summary: 'The picker screen lists every campaign on this browser profile.',
    tips: [
      'New campaign: the "New campaign" button — name, game system, short setting description.',
      'Open a campaign with its card button; the ⋮ menu offers "Export campaign…" (pick artifacts, JSON file or zip bundle — zip includes images) and Delete (with confirmation — removes artifacts, revisions and runs).',
      'Import JSON: the "Import JSON" button accepts files exported from any Campaigner; an import always creates a fresh copy and never overwrites existing data.',
      'Deleting a campaign only removes it from this browser; exports are your backup.',
    ],
    keywords: 'picker create delete import export',
  },
  tree: {
    title: 'Artifact library (left pane)',
    summary:
      'The tree holds campaign and module artifacts by kind, plus the optional shared Library group.',
    tips: [
      'Create: the + button next to each kind header.',
      'Open: click a row to load it into the editor.',
      'Delete: hover a row and click the trash icon (confirmation dialog). This removes the artifact, its whole revision history, and any links other artifacts pointed at it.',
      'Right-click a row for the full menu: Rename, Duplicate, Export as JSON, Export PDF (GM notes or player handout).',
      'Filter: the search box narrows by name or tag.',
      'Link graph: the button under the filter opens a visual map of all links between artifacts.',
    ],
    keywords:
      'artifacts npc location faction note encounter plot arc library scope delete rename',
  },
  editor: {
    title: 'Artifact editor (middle pane)',
    summary:
      'Edit one artifact: name, tags, summary, body, kind-specific fields, links and revision history.',
    tips: [
      'Changes autosave; the revision badge shows the current version.',
      'History (clock icon): every save snapshots a revision — open the dialog to inspect or restore any older snapshot.',
      'Tags group artifacts and feed the tree filter.',
      'Links connect artifacts (e.g. NPC "lives in" location). Links created here appear in the link graph and can be exported.',
      'Kind-specific sections: NPCs can carry a full stat block; encounters have monsters and tactics; plot arcs have beats and hooks.',
      'When a persona run finishes, its draft lands in the editor — accept, edit further, or discard it.',
    ],
    keywords: 'autosave revisions restore tags links statblock draft',
  },
  assistant: {
    title: 'Assistant (personas)',
    summary:
      'Personas are writing specialists (NPC Smith, Location Architect, Faction Designer, Plot Architect, Encounter Smith, Encounter Cartographer, Continuity Editor) that draft or review artifacts using pinned rule text.',
    tips: [
      'Pick a persona, an autonomy mode, and write a brief: Manual pauses for your approval on every step, Review runs through but pauses on problems, Auto runs to completion.',
      'Encounter Cartographer turns a brief into a sourced roster, deterministic room layout and structure-verified battlemap; regenerating an encounter preserves its authored prose and roster.',
      'Review personas (Continuity Editor) check an existing artifact for contradictions and write a continuity report — pick the artifact to check instead of writing a brief.',
      'Add "Artifacts created earlier" to give the persona extra context from this campaign.',
      'While a run streams you can approve, retry with an edited brief, or cancel. Manual mode waits for you between steps.',
      'Finished runs produce a draft artifact in the campaign tree with full revision history.',
    ],
    keywords: 'persona llm run approve retry cancel autonomy continuity review',
  },
  'writers-room': {
    title: "Writers' room (persona chaining)",
    summary:
      'Chain personas into a pipeline: each step drafts an artifact, and later steps receive earlier outputs as context.',
    tips: [
      'Add steps, each with its own persona, autonomy mode and brief.',
      'Typical chain: Plot Architect (arc) → Encounter Smith (set piece) → NPC Smith (villain) — later steps see what earlier ones produced.',
      'A chain pauses when a Manual/Review step asks for input; resolve it in the Assistant tab, then Resume the chain here.',
      'If a step fails, completed steps are kept as context — "Retry failed step" re-runs only that step and continues the chain. The failed run stays in the Runs tab with its error.',
      'Stop cancels the chain after the current step.',
    ],
    keywords: 'chain pipeline steps resume pause sequence',
  },
  module: {
    title: 'Modules (markdown adventure documents)',
    summary:
      'A Module is a markdown adventure document with [[wiki-links]]; structured artifacts (NPCs, locations, encounters…) are annotations that hang off the prose — not a pile of forms.',
    tips: [
      'New Module (top bar or the Modules page) drafts a spine first: premise + part plan, each part with a level band. Approve it, then parts generate one by one, each seeing the previous parts for continuity.',
      'The reader shows the module as one document: a table of contents on the left, the prose in the middle, and an entity panel on the right listing every mentioned character, place, faction or item.',
      '[[Names]] in the text become colored chips: a solid chip means the artifact exists and opens a peek; a dashed chip is unresolved and can create, generate, or link an artifact.',
      'Every part can be edited in place (✎) and rewritten (↺) with an optional instruction; rewriting a hand-edited part asks first. Failed parts show a Retry button without touching the rest.',
      'The entity panel can batch-generate unresolved entities, including encounter stubs. “Generate encounter maps” runs the Cartographer unattended for mapless module encounters and keeps failures retryable.',
      'Deliverables → "Seed from module" turns a finished module into a printable outline: premise as intro, one chapter per part with its resolved entities attached.',
    ],
    keywords: 'module wiki links spine parts entities stub batch pdf deliverable',
  },
  runs: {
    title: 'Runs',
    summary: 'History of persona runs for this campaign, newest first.',
    tips: [
      'Click a run to expand its step log (retrieval, drafts, decisions).',
      'The trash icon on a run removes it from history (the artifacts it produced stay).',
      'Failed runs show their error message — retry from the Assistant tab.',
    ],
    keywords: 'history log steps delete',
  },
  rules: {
    title: 'Rulebooks',
    summary:
      'Import PDF rulebooks; they are split into searchable chunks (sections, stat blocks, tables).',
    tips: [
      'Import PDFs: pick one or more files; progress shows per book. The original PDF bytes are never stored — deleting a book and re-importing needs the file again.',
      'Each book card shows status: processing (with page progress), ready (with chunk count), or error (hover the message for details; ⋮ menu offers Retry…).',
      'Rename a book or change its game system from the ⋮ menu.',
      'Delete: the trash button on the card removes the book and its chunks (cached embeddings are kept — they are content-addressed).',
      'Chunks power both keyword and semantic search, and can be pinned for persona runs.',
    ],
    keywords: 'pdf import ingest chunks books retry delete',
  },
  search: {
    title: 'Rules search & pins',
    summary:
      'Hybrid search across all imported rulebooks: keyword matching plus semantic (embedding) similarity when embeddings are active.',
    tips: [
      'Results show book title and page range — click to expand the full chunk text.',
      'Pin a chunk (pin icon) to attach it to persona runs; pinned chunks are offered to every persona as grounding.',
      'Filters narrow by book, chunk type (sections / stat blocks / tables).',
      'Semantic search needs an API key and embeddings enabled (Settings); otherwise keyword search still works.',
    ],
    keywords: 'keyword semantic pin pins hybrid find',
  },
  embeddings: {
    title: 'Embeddings',
    summary:
      'Embeddings enable semantic ("means the same") rule search on top of keyword search. They are cached per chunk and model.',
    tips: [
      'Enable in Settings (needs an OpenRouter API key). The panel shows how many chunks are embedded for the current model.',
      'Embed whole library: embeds every not-yet-embedded chunk in batches with a progress bar. Also per-book: "Embed whole book" in a card menu.',
      'Changing the embedding model in Settings invalidates the cache — embed again for the new model.',
      'Clear removes all cached vectors (keyword search keeps working).',
    ],
    keywords: 'semantic vector model cache clear api',
  },
  graph: {
    title: 'Link graph',
    summary:
      'A visual map of the campaign: artifacts as nodes clustered by kind, links as labeled edges.',
    tips: [
      'Click a node to open that artifact in the editor.',
      'Edge labels show the relation (e.g. "lives-in"); dangling links to deleted artifacts are filtered out automatically.',
      'Use it to spot isolated artifacts that could use more connections.',
      'Back to workspace with the arrow button, top left.',
    ],
    keywords: 'graph links map relations visualize',
  },
  settings: {
    title: 'Settings',
    summary: 'OpenRouter connection, models, personas and the danger zone.',
    tips: [
      'Paste your OpenRouter API key and use "Test key" to verify it. The key is stored only in this browser.',
      'Default chat model is used by all personas unless a persona overrides it; the embedding model powers semantic search (enable the toggle).',
      'Personas: expand a persona to edit its name, model override, temperature and prompt. Built-in personas can be reset to their shipped prompt; they are never overwritten by updates.',
      'Danger zone: "Delete all data" wipes every campaign, artifact, rulebook, chunk, embedding, persona edit and run in this browser (theme preference survives).',
    ],
    keywords: 'api key model temperature persona prompt danger delete reset',
  },
  shortcuts: {
    title: 'Keyboard & interaction',
    summary: 'Small things that make the app faster to drive.',
    tips: [
      '? opens this help (when not typing in a field).',
      'Right-click artifacts in the tree for the full row menu; hover rows/cards for the delete buttons.',
      'Esc closes dialogs and menus.',
      'Everything autosaves — there is no explicit save button by design.',
    ],
    keywords: 'keyboard shortcuts escape hotkey',
  },
};

export const HELP_TOPIC_IDS = Object.keys(HELP_CONTENT) as HelpTopic[];
