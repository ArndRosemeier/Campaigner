import { ROUTES } from '@/app/routes';

/**
 * Single source of truth for the First-Module Guide (05-UI.md §Guide): plain
 * data, like /src/help/helpContent.ts — the GuidePage renders it and a test
 * guarantees completeness and that every app link points at a real route.
 * Opened in another tab (welcome wizard, help, empty states); the guide is
 * the authored path: campaign → module → spine → parts → cast → battlemaps →
 * table.
 */

/** Where a chapter's "Do it now" button leads. */
export type GuideAppRoute =
  | { kind: 'static'; path: string }
  /** Campaign-scoped: resolves against the most recently updated campaign;
      renders as a disabled hint while no campaign exists. */
  | { kind: 'campaign'; section: 'workspace' | 'modules' | 'deliverables' };

export interface GuideAppLink {
  label: string;
  route: GuideAppRoute;
}

export interface GuideSection {
  heading: string;
  markdown: string;
}

export interface GuideChapter {
  id: string;
  title: string;
  minutes: number;
  intro: string;
  sections: GuideSection[];
  appLink?: GuideAppLink;
  /** One line: how the reader knows the chapter is done. */
  checkpoint: string;
}

const openModules: GuideAppLink = {
  label: 'Open Modules in the app',
  route: { kind: 'campaign', section: 'modules' },
};

export const GUIDE_CHAPTERS: readonly GuideChapter[] = [
  {
    id: 'start-here',
    title: 'Start here',
    minutes: 2,
    intro:
      'This guide walks you from an empty browser to one playable module — authored, generated, resolved and run at the table. It takes about 30 minutes and a few cents of OpenRouter credit.',
    sections: [
      {
        heading: 'What you will build',
        markdown:
          'One campaign holding one Module: a markdown adventure with a premise, level-banded parts, and every character, place, faction and encounter mentioned in its prose as a real artifact — finished with battlemaps and a printable outline.',
      },
      {
        heading: 'Before you start',
        markdown:
          '- An OpenRouter key saved in Settings (the setup wizard\'s second step walks you through it — press "Test key" until you see "Key works").\n- A few dollars of credit on openrouter.ai.\n- Optionally, a rulebook PDF you own — pinned rule text grounds every generation in your system\'s rules.',
      },
      {
        heading: 'How to read this guide',
        markdown:
          'Chapters 1–3 set the stage; 4–7 are the authoring loop; 8 takes it to the table. Every chapter ends with a "Do it now" button that opens the app and a checkpoint line telling you when to move on.',
      },
    ],
    checkpoint: 'You are done here when you have your key working and a folder of module ideas in your head.',
  },
  {
    id: 'campaign',
    title: 'Create the campaign',
    minutes: 3,
    intro:
      'The campaign is the container: its artifacts, its modules, its rulebook pins — and its game system, which stat blocks, bestiary packs and battle setup all read.',
    sections: [
      {
        heading: 'New campaign',
        markdown:
          'On the campaign picker press "New Campaign". Give it a name, pick the game system, and add one or two sentences about the setting — the description is shown to writing personas later, so a vivid line here is free grounding.',
      },
      {
        heading: 'Which system?',
        markdown:
          'D&D 5e, Pathfinder 2e, Cosmere, Generic d20 or Other. The choice labels stat blocks and defaults the encounter generator\'s monster sourcing; it can be re-set later, but pick the system you actually run now.',
      },
    ],
    appLink: { label: 'Open the campaign picker', route: { kind: 'static', path: ROUTES.campaignPicker } },
    checkpoint: 'You are done when the workspace opens with your campaign\'s name in the switcher.',
  },
  {
    id: 'rules',
    title: 'Load rules & pin (optional)',
    minutes: 5,
    intro:
      'Rulebooks are optional but recommended: imported books split into searchable chunks, and pinned chunks are offered to every persona run as grounding.',
    sections: [
      {
        heading: 'Import a PDF',
        markdown:
          'On Rules, press "Import PDFs" and pick a rulebook PDF you own. Import shows per-book page progress and finishes with a chunk count. Scanned, image-only PDFs fail loudly — use text PDFs. Original files are never stored: deleting a book and re-importing needs the file again.',
      },
      {
        heading: 'Pin what matters',
        markdown:
          'Search the book, expand a hit, and pin two or three chunks your module will lean on (a condition, a spell, a faction\'s rules). Pins apply to every run; unpinned keyword search still works everywhere.',
      },
    ],
    appLink: { label: 'Open Rules', route: { kind: 'static', path: ROUTES.rules } },
    checkpoint: 'You are done when the book card reads "ready" with a chunk count and you have pinned a chunk or two.',
  },
  {
    id: 'create-module',
    title: 'Create the module',
    minutes: 5,
    intro:
      'A Module is a markdown adventure document; structured artifacts hang off its prose as wiki-links, not the other way around. Creation starts with one vivid concept.',
    sections: [
      {
        heading: 'The creation dialog',
        markdown:
          'Press "Module" in the top bar (or "New Module" on the Modules page). Fields:\n- **Concept** — one vivid sentence: "smugglers\' cove gone eldritch — the party raids a smuggling den that has dug into something older."\n- **Level from/to** — the band the parts are written for.\n- **Tone** (optional) — "grim", "folk-horror", "swashbuckling" steer the prose.\n- **Size** — sketch ≈ 400–700 words per part, standard ≈ 800–1500, detailed ≈ 1500–2500.',
      },
      {
        heading: 'Leave the pass automation off — the first time',
        markdown:
          'The "After the parts are written" grid (auto-generate/auto-image per kind) runs unattended passes once the parts finish. For your first module leave it off: you will run each pass manually, learn what it does, and automate later. Battlemaps are the exception — every encounter a module creates is mapped automatically with the campaign\'s defaults (untick "Generate encounter battlemaps" to keep maps manual for that module). "Generate parts without review" (skip the spine checkpoint) should also stay off.',
      },
    ],
    appLink: openModules,
    checkpoint: 'You are done when the module reader opens and the spine draft starts streaming.',
  },
  {
    id: 'spine',
    title: 'Approve the spine',
    minutes: 5,
    intro:
      'The spine is the module\'s premise plus its part plan — always shown for approval before any part is written. It is the cheapest place to reshape the adventure.',
    sections: [
      {
        heading: 'Read it as an editor',
        markdown:
          'The premise and every planned part are fully editable: fix names, reorder parts, delete or add rows, adjust level bands. The normalized entity glossary under the plan is read-only — renaming a character there is an ordinary plan edit on the part rows.',
      },
      {
        heading: 'Retry with a steering instruction',
        markdown:
          'Not the story you want? "Retry spine…" re-runs the draft with an optional instruction ("more political, less combat", "the villain should be the harbormaster"). Retry as often as you like — nothing is spent on parts until you press "Generate parts".',
      },
      {
        heading: 'Then let it write',
        markdown:
          '"Generate parts" approves the spine and writes the parts one by one, each seeing the previous parts for continuity. You can keep reading while it streams; a failed part retries alone without touching the rest.',
      },
    ],
    appLink: openModules,
    checkpoint: 'You are done when every part of the plan has prose and the reader shows the whole document.',
  },
  {
    id: 'parts',
    title: 'Read, edit, rewrite',
    minutes: 10,
    intro:
      'The reader is the module: contents on the left, the prose in the middle, the entity panel on the right. Parts are individually editable and rewritable.',
    sections: [
      {
        heading: 'Edit in place',
        markdown:
          'The ✎ on a part opens it as markdown — autosaved with full revision history, like every artifact. Fix a name, punch up a line, restructure a scene; the chips re-resolve as you type.',
      },
      {
        heading: 'Rewrite with an instruction',
        markdown:
          'The ↺ rewrites the part through the persona with an optional instruction ("tighten to 600 words", "the betrayal happens here"). Rewriting a part you hand-edited asks first, so your edits are never silently lost.',
      },
      {
        heading: 'Wiki-link chips',
        markdown:
          'A solid chip is a resolved artifact — click it for a peek without leaving the page. A dashed chip is an unresolved name: the module\'s to-do list. Chapter 6 resolves them. Failed parts show a Retry button; nothing else is touched.',
      },
    ],
    appLink: openModules,
    checkpoint: 'You are done when you have edited or rewritten at least one part and the prose reads the way you want.',
  },
  {
    id: 'cast',
    title: 'Resolve the cast',
    minutes: 10,
    intro:
      'Every dashed chip is a name the prose needs made real: create it empty, generate it with a persona, or point it at an existing artifact.',
    sections: [
      {
        heading: 'One chip at a time',
        markdown:
          'Click a dashed chip: the stub popover offers create (empty artifact), generate (the matching persona drafts it from the surrounding prose and pins), or use existing (alias an entity you already have — "the Old Lighthouse" already exists as a location).',
      },
      {
        heading: 'Or batch the rest',
        markdown:
          'The entity panel lists every unresolved name. "Batch generate" details them one run at a time — encounters included as encounter stubs with sourced rosters. Failures stay retryable and never stop the rest of the queue.',
      },
      {
        heading: 'Portraits',
        markdown:
          'Any artifact can carry an image (the image icon on the entity, or the persona\'s illustration run). Image generation is off until you enable it in Settings — it costs per image and is purely optional.',
      },
    ],
    appLink: openModules,
    checkpoint: 'You are done when no dashed chips remain in the entity panel — the graph page should show a clean campaign, no phantoms.',
  },
  {
    id: 'battlemaps',
    title: 'Battlemaps',
    minutes: 5,
    intro:
      'Encounters can get a generated battlemap: a deterministic room layout and stylized candidates you judge yourself — unattended, per encounter.',
    sections: [
      {
        heading: 'Generate encounter maps',
        markdown:
          'Encounters created by automation — an encounter persona run, a module batch, or the post-parts pass — are mapped automatically: an unattended Cartographer run with the campaign\'s defaults, the Dungeon tier only for dungeon encounters. An encounter that already has a map (or a map in the queue) is never re-mapped automatically; regenerating stays your explicit call — the encounter editor offers exactly two automatic actions, Regenerate everything (new roster, layout and map) and Repopulate (new roster, map kept).',
      },
      {
        heading: 'Pick, aspect, failure',
        markdown:
          'You are the judge: every manual run pauses at the map pick, and "Regenerate candidates" re-runs only the image step (same layout, same brief) when none of the candidates suits you. Regenerating the LAYOUT — fresh room keys and geometry — stays the separate affordance in the layout review. The layout aspect preference lives in Settings. Maps without a generated layout fall back to the legacy pixel grid.',
      },
    ],
    appLink: openModules,
    checkpoint: 'You are done when every encounter you plan to run shows a battlemap thumbnail.',
  },
  {
    id: 'table',
    title: 'To the table & print',
    minutes: 10,
    intro:
      'Run the battle live, then turn the module into print. Both surfaces read from the module — nothing is re-entered.',
    sections: [
      {
        heading: 'Run battle',
        markdown:
          '"Battle table" (reader header) opens the full-screen board for the module\'s live encounter; encounter rows offer "Run battle" to seed it — mobs drop onto the map with HP, PCs stage at the entry zone, a veil covers each room\'s monsters (player view drops those tokens from the DOM until the cover lifts), initiative rolls on enable. Player view strips secrets from the DOM; "Back to module" exits in one click.',
      },
      {
        heading: 'Print',
        markdown:
          'Deliverables → "Seed from module" turns the finished module into a printable outline: the premise as intro, one chapter per part with its resolved entities attached. Export GM notes or player handouts as PDF.',
      },
    ],
    appLink: {
      label: 'Open Deliverables in the app',
      route: { kind: 'campaign', section: 'deliverables' },
    },
    checkpoint: 'You are done when the module has survived a session or a printout — welcome to the loop. The next module automates what you just learned.',
  },
];

/** The chapter for a route param, or undefined for an unknown id. */
export function guideChapter(id: string | undefined): GuideChapter | undefined {
  if (id === undefined) return GUIDE_CHAPTERS[0];
  return GUIDE_CHAPTERS.find((chapter) => chapter.id === id);
}
