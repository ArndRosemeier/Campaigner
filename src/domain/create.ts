import {
  artifactSchema,
  type Artifact,
  type ArtifactData,
  type ArtifactKind,
  type ArtifactLink,
  type FactionArtifact,
  type LocationArtifact,
  type NpcArtifact,
  type NoteArtifact,
  type PcArtifact,
} from '@/domain/artifact';
import { campaignSchema, type Campaign, type NewCampaign } from '@/domain/campaign';
import { stampNewEntity, type Id } from '@/domain/entity';
import { DEFAULT_PERSONA_TEMPERATURE, personaSchema, type Persona } from '@/domain/persona';
import { rulebookSchema, type Rulebook } from '@/domain/rulebook';
import { personaRunSchema, type Autonomy, type PersonaRun } from '@/domain/run';
import type { GameSystem } from '@/domain/gameSystem';
import { statBlockSchema, type StatBlock } from '@/domain/statblock';

/**
 * Centralized factories for new entities — the only place "blank" states are
 * defined, so features never hand-roll defaults (T3's tree `+` buttons, the
 * campaign picker dialog and the run engine all build on these).
 */

/** Default names for blank artifacts — always non-empty (names are required). */
export const DEFAULT_ARTIFACT_NAMES: Readonly<Record<ArtifactKind, string>> = {
  pc: 'New PC',
  npc: 'New NPC',
  location: 'New Location',
  faction: 'New Faction',
  note: 'New Note',
  encounter: 'New Encounter',
  plotarc: 'New Plot Arc',
  session: 'New Session',
};

export function defaultArtifactName(kind: ArtifactKind): string {
  return DEFAULT_ARTIFACT_NAMES[kind];
}

/** An empty-but-valid StatBlock to start the stat-block form from. */
export function blankStatBlock(system: GameSystem): StatBlock {
  return statBlockSchema.parse({
    system,
    level: '',
    size: '',
    creatureType: '',
    ac: 10,
    acNote: '',
    hp: 1,
    hpFormula: '',
    speed: '',
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
  });
}

/** The blank structured data for a kind, per 01-DATA-MODEL. */
export function blankArtifactData(kind: ArtifactKind): ArtifactData {
  switch (kind) {
    case 'pc':
      return {
        playerName: '',
        statBlock: null,
        currentHp: 0,
        initiativeOverride: null,
        notes: '',
      };
    case 'npc':
      return {
        role: '',
        appearance: '',
        personality: '',
        motivation: '',
        secrets: '',
        voiceNotes: '',
        statBlock: null,
      };
    case 'location':
      return { locationType: '', inhabitants: '', pointsOfInterest: [], hooks: [] };
    case 'faction':
      return { goals: '', methods: '', resources: '', ranks: [] };
    case 'note':
      return {};
    case 'encounter':
      return {
        difficulty: '',
        levelHint: '',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
      };
    case 'plotarc':
      return { arcType: '', premise: '', stakes: '', beats: [], hooks: [], climax: '' };
    case 'session':
      return { sessionNumber: '', recap: '', prep: [], openThreads: [], scenes: [], log: '' };
  }
}

export interface CreateArtifactInput<K extends ArtifactKind = ArtifactKind> {
  campaignId: Id;
  kind: K;
  name: string;
  tags?: readonly string[];
  /** Alternate names module wiki-links resolve against (M4-A). */
  aliases?: readonly string[];
  summary?: string;
  body?: string;
  links?: readonly ArtifactLink[];
  data?: ArtifactData;
}

export function createArtifact(input: CreateArtifactInput<'pc'>): PcArtifact;
export function createArtifact(input: CreateArtifactInput<'npc'>): NpcArtifact;
export function createArtifact(input: CreateArtifactInput<'location'>): LocationArtifact;
export function createArtifact(input: CreateArtifactInput<'faction'>): FactionArtifact;
export function createArtifact(input: CreateArtifactInput<'note'>): NoteArtifact;
export function createArtifact(input: CreateArtifactInput): Artifact;
export function createArtifact(input: CreateArtifactInput): Artifact {
  const stamp = stampNewEntity();
  const artifact = {
    ...stamp,
    campaignId: input.campaignId,
    kind: input.kind,
    name: input.name,
    tags: [...(input.tags ?? [])],
    aliases: [...(input.aliases ?? [])],
    summary: input.summary ?? '',
    body: input.body ?? '',
    links: [...(input.links ?? [])],
    currentRevision: 1,
    imageIds: [],
    coverImageId: null,
    data: input.data ?? blankArtifactData(input.kind),
  };
  // Parse instead of casting: guarantees every artifact entering the DB
  // satisfies the discriminated union (kind must match its data shape).
  return artifactSchema.parse(artifact);
}

export function createCampaign(input: NewCampaign): Campaign {
  const stamp = stampNewEntity();
  return campaignSchema.parse({
    ...stamp,
    name: input.name,
    description: input.description ?? '',
    system: input.system,
  });
}

export interface NewRulebook {
  title: string;
  system: GameSystem;
  filename: string;
  pageCount?: number;
}

export function createRulebook(input: NewRulebook): Rulebook {
  const stamp = stampNewEntity();
  return rulebookSchema.parse({
    ...stamp,
    title: input.title,
    system: input.system,
    filename: input.filename,
    pageCount: input.pageCount ?? 0,
    status: 'processing',
    errorMessage: '',
  });
}

export interface NewPersona {
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  temperature?: number;
  /**
   * Artifact kind the persona outputs. Required unless mode is 'image'
   * (image personas decorate existing artifacts and never create one).
   */
  producesKind?: ArtifactKind;
  mode?: Persona['mode'];
  builtIn: boolean;
}

export function createPersona(input: NewPersona): Persona {
  const stamp = stampNewEntity();
  if (input.mode !== 'image' && input.producesKind === undefined) {
    throw new Error(`Persona "${input.slug}" must declare producesKind (mode ${input.mode ?? 'generate'})`);
  }
  return personaSchema.parse({
    ...stamp,
    slug: input.slug,
    name: input.name,
    description: input.description,
    systemPrompt: input.systemPrompt,
    model: input.model ?? '',
    temperature: input.temperature ?? DEFAULT_PERSONA_TEMPERATURE,
    ...(input.producesKind === undefined ? {} : { producesKind: input.producesKind }),
    mode: input.mode ?? 'generate',
    builtIn: input.builtIn,
  });
}

export interface NewPersonaRun {
  campaignId: Id;
  personaId: Id;
  autonomy: Autonomy;
  userBrief: string;
  pinnedChunkIds?: readonly Id[];
  /** Review/image personas: the artifact under review/decoration. */
  targetArtifactId?: Id | null;
}

export function createPersonaRun(input: NewPersonaRun): PersonaRun {
  const stamp = stampNewEntity();
  return personaRunSchema.parse({
    ...stamp,
    campaignId: input.campaignId,
    personaId: input.personaId,
    autonomy: input.autonomy,
    status: 'running',
    userBrief: input.userBrief,
    pinnedChunkIds: [...(input.pinnedChunkIds ?? [])],
    steps: [],
    resultArtifactId: null,
    targetArtifactId: input.targetArtifactId ?? null,
    errorMessage: '',
  });
}
