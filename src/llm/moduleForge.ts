import type { Campaign, Id, Persona } from '@/domain';
import { BUILT_IN_PERSONAS } from '@/llm/personas/builtins';
import { chainRunner, type ChainStepInput, type ChainState } from '@/llm/chainRunner';
import { getArtifact } from '@/db/artifactRepo';

/**
 * Module Forge (M3): one-click generation of a whole adventure module. Builds
 * a plan of chain steps from a short concept, runs it fully automatic, then —
 * optionally — reads the continuity report and runs a refinement pass for the
 * flagged artifacts. Each refinement produces a NEW artifact (the engine
 * never overwrites), so original and revision can be compared and the weaker
 * one deleted.
 */

export interface ModuleForgeOptions {
  /** One-or-two sentence concept of the module. */
  concept: string;
  sessions: number;
  npcs: number;
  locations: number;
  factions: number;
  encounters: number;
  /** Run a Continuity Editor pass and auto-refine flagged artifacts. */
  refinePass: boolean;
}

export const DEFAULT_MODULE_OPTIONS: ModuleForgeOptions = {
  concept: '',
  sessions: 1,
  npcs: 3,
  locations: 2,
  factions: 1,
  encounters: 2,
  refinePass: true,
};

/** Persona slugs the forge is built on (all built-in). */
const FORGE_SLUGS = {
  arc: 'arc-weaver',
  session: 'session-chronicler',
  location: 'worldbuilder',
  faction: 'faction-designer',
  npc: 'npc-smith',
  encounter: 'encounter-smith',
  continuity: 'continuity-editor',
} as const;

function personaBySlug(personas: readonly Persona[], slug: string): Persona {
  const persona =
    personas.find((candidate) => candidate.slug === slug) ??
    BUILT_IN_PERSONAS.find((candidate) => candidate.slug === slug);
  if (persona === undefined) {
    throw new Error(`Module forge requires the built-in persona "${slug}"`);
  }
  return persona;
}

/** Repeats a step builder n times with a 1-based counter in the brief. */
function repeat(count: number, build: (index: number) => ChainStepInput): ChainStepInput[] {
  return Array.from({ length: Math.max(0, count) }, (_, zero) => build(zero + 1));
}

/**
 * The generation plan: arc first (everything else leans on it), then
 * sessions, locations, factions, NPCs, encounters, and — when refining — a
 * continuity check over the whole set. All steps run automatic.
 */
export function buildModuleSteps(
  options: ModuleForgeOptions,
  personas: readonly Persona[],
): ChainStepInput[] {
  const arc = personaBySlug(personas, FORGE_SLUGS.arc);
  const session = personaBySlug(personas, FORGE_SLUGS.session);
  const location = personaBySlug(personas, FORGE_SLUGS.location);
  const faction = personaBySlug(personas, FORGE_SLUGS.faction);
  const npc = personaBySlug(personas, FORGE_SLUGS.npc);
  const encounter = personaBySlug(personas, FORGE_SLUGS.encounter);

  const steps: ChainStepInput[] = [
    {
      personaId: arc.id,
      title: 'Plot arc',
      brief: `Design the central plot arc of the module. Concept: ${options.concept}`,
      autonomy: 'auto',
    },
    ...repeat(options.sessions, (index) => ({
      personaId: session.id,
      title: `Session ${index}`,
      brief: `Plan session ${index} of the module. Concept: ${options.concept}. Build it on the plot arc created earlier in this pipeline.`,
      autonomy: 'auto' as const,
    })),
    ...repeat(options.locations, (index) => ({
      personaId: location.id,
      title: `Key location ${index}`,
      brief: `Create key location ${index} of the module. Concept: ${options.concept}. It must serve the plot arc created earlier in this pipeline.`,
      autonomy: 'auto' as const,
    })),
    ...repeat(options.factions, (index) => ({
      personaId: faction.id,
      title: `Faction ${index}`,
      brief: `Create faction ${index} of the module. Concept: ${options.concept}. Motivate it by the stakes of the plot arc created earlier in this pipeline.`,
      autonomy: 'auto' as const,
    })),
    ...repeat(options.npcs, (index) => ({
      personaId: npc.id,
      title: `Key NPC ${index}`,
      brief: `Create key NPC ${index} of the module with a full stat block. Concept: ${options.concept}. Tie the NPC to the arc, locations and factions created earlier in this pipeline.`,
      autonomy: 'auto' as const,
    })),
    ...repeat(options.encounters, (index) => ({
      personaId: encounter.id,
      title: `Encounter ${index}`,
      brief: `Design combat encounter ${index} of the module. Concept: ${options.concept}. Use the NPCs, locations and factions created earlier in this pipeline.`,
      autonomy: 'auto' as const,
    })),
  ];

  if (options.refinePass) {
    const continuity = personaBySlug(personas, FORGE_SLUGS.continuity);
    steps.push({
      personaId: continuity.id,
      title: 'Continuity review',
      brief:
        'Review the plot arc of this module against everything else generated in this pipeline.',
      autonomy: 'auto',
      reviewTarget: 'first',
    });
  }

  return steps;
}

/** Phase of the forge (refine only ever runs when refinePass is on). */
export type ForgePhase = 'idle' | 'generating' | 'refining' | 'completed' | 'failed' | 'cancelled';

export interface ForgeState {
  phase: ForgePhase;
  chain: ChainState;
}

type ForgeListener = (state: ForgeState) => void;

/**
 * Orchestrates generate → (report?) → refine. The generation chain is the
 * plan from buildModuleSteps; when its final continuity report says
 * "issues_found", a second chain revises the flagged artifacts (identified
 * by the report's relatedTo names) with their original generator personas.
 */
export class ModuleForge {
  private listeners = new Set<ForgeListener>();
  private state: ForgeState = {
    phase: 'idle',
    chain: chainRunner.getState(),
  };
  private cancelRequested = false;
  private chainUnsubscribe: (() => void) | null = null;

  on(listener: ForgeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot: ForgeState = { phase: this.state.phase, chain: this.state.chain };
    for (const listener of this.listeners) listener(snapshot);
  }

  getState(): ForgeState {
    return this.state;
  }

  cancel(): void {
    this.cancelRequested = true;
    chainRunner.cancel();
  }

  /**
   * Re-reads the cancel flag after an await: cancel() fires from the UI while
   * a chain is in flight, but TypeScript's property narrowing cannot see that
   * and would treat the field as still `false` after run() reset it.
   */
  private cancelWasRequested(): boolean {
    return this.cancelRequested;
  }

  reset(): void {
    this.cancelRequested = false;
    this.chainUnsubscribe?.();
    this.chainUnsubscribe = null;
    chainRunner.reset();
    this.state = { phase: 'idle', chain: chainRunner.getState() };
    this.emit();
  }

  /** Runs the whole forge; resolves with the final phase. */
  async run(
    campaign: Campaign,
    personas: readonly Persona[],
    options: ModuleForgeOptions,
    pinnedChunkIds: readonly Id[],
  ): Promise<ForgeState> {
    this.cancelRequested = false;
    this.chainUnsubscribe = chainRunner.on((chain) => {
      this.state = { ...this.state, chain };
      this.emit();
    });

    this.state = { phase: 'generating', chain: chainRunner.getState() };
    this.emit();

    const generateSteps = buildModuleSteps(options, personas);
    const generateResult = await chainRunner.run(
      campaign,
      personas,
      generateSteps,
      'auto',
      pinnedChunkIds,
    );

    if (generateResult.status !== 'completed') {
      this.state.phase =
        generateResult.status === 'cancelled' || this.cancelWasRequested()
          ? 'cancelled'
          : 'failed';
      this.emit();
      return this.state;
    }

    if (!options.refinePass) {
      this.state.phase = 'completed';
      this.emit();
      return this.state;
    }

    this.state.phase = 'refining';
    this.emit();

    const producedIds = generateResult.steps
      .map((step) => step.artifactId)
      .filter((id): id is Id => id !== null);
    const refineSteps = await buildRefineSteps(producedIds, personas);
    if (refineSteps.length === 0) {
      this.state.phase = 'completed';
      this.emit();
      return this.state;
    }

    const refineResult = await chainRunner.run(
      campaign,
      personas,
      refineSteps,
      'auto',
      pinnedChunkIds,
    );
    this.state.phase =
      refineResult.status === 'completed'
        ? 'completed'
        : refineResult.status === 'cancelled' || this.cancelWasRequested()
          ? 'cancelled'
          : 'failed';
    this.emit();
    return this.state;
  }
}

/** Parsed continuity findings from a report note's markdown body. */
export interface ParsedReport {
  verdict: 'consistent' | 'issues_found';
  issues: { severity: 'minor' | 'major'; message: string; relatedTo: string }[];
}

const ISSUE_LINE = /^- \*\*\[(minor|major)\]\*\* (.+?)(?: \(relates to: (.+)\))?$/;

/**
 * Parses the markdown body the run engine writes for a continuity report
 * (`**Verdict:** …` + `- **[severity]** message (relates to: …)` lines).
 */
export function parseContinuityReportBody(body: string): ParsedReport {
  const issues: ParsedReport['issues'] = [];
  for (const line of body.split('\n')) {
    const match = ISSUE_LINE.exec(line.trim());
    if (match === null) continue;
    issues.push({
      severity: (match[1] ?? 'minor') === 'major' ? 'major' : 'minor',
      message: match[2] ?? '',
      relatedTo: match[3] ?? '',
    });
  }
  return {
    verdict: body.includes('**Verdict:** issues found') ? 'issues_found' : 'consistent',
    issues,
  };
}

/**
 * Reads the continuity report (the last produced artifact, a continuity
 * note) and builds one refinement step per flagged artifact: the artifact's
 * generator persona is re-run with the findings as input, producing a
 * corrected version as a new artifact.
 */
export async function buildRefineSteps(
  producedIds: readonly Id[],
  personas: readonly Persona[],
): Promise<ChainStepInput[]> {
  const reportArtifactId = producedIds[producedIds.length - 1];
  if (reportArtifactId === undefined) return [];
  const reportArtifact = await getArtifact(reportArtifactId);
  if (reportArtifact?.kind !== 'note') return [];

  const report = parseContinuityReportBody(reportArtifact.body);
  if (report.verdict !== 'issues_found' || report.issues.length === 0) return [];

  const findings = report.issues
    .map(
      (issue) =>
        `- [${issue.severity}] ${issue.message}${issue.relatedTo === '' ? '' : ` (relates to: ${issue.relatedTo})`}`,
    )
    .join('\n');

  // Flagged artifacts by name (relatedTo), falling back to the plot arc
  // (the first produced artifact) when nothing matches.
  const steps: ChainStepInput[] = [];
  const flaggedNames = new Set(
    report.issues.map((issue) => issue.relatedTo).filter((name) => name !== ''),
  );
  const slugForKind: Record<string, string> = {
    plotarc: FORGE_SLUGS.arc,
    session: FORGE_SLUGS.session,
    location: FORGE_SLUGS.location,
    faction: FORGE_SLUGS.faction,
    npc: FORGE_SLUGS.npc,
    encounter: FORGE_SLUGS.encounter,
  };

  for (const id of producedIds) {
    const artifact = await getArtifact(id);
    if (artifact === undefined || artifact.kind === 'note') continue;
    if (flaggedNames.size > 0 && !flaggedNames.has(artifact.name)) continue;
    const persona = personaBySlug(personas, slugForKind[artifact.kind] ?? FORGE_SLUGS.npc);
    steps.push({
      personaId: persona.id,
      title: `Refine: "${artifact.name}"`,
      brief: [
        `A continuity review flagged the ${artifact.kind} "${artifact.name}" of this module.`,
        `Its current summary: ${artifact.summary}`,
        'Findings to fix:',
        findings,
        'Produce a corrected, self-consistent version that resolves every finding while keeping the rest of the module intact.',
      ].join('\n'),
      autonomy: 'auto',
    });
  }

  if (steps.length === 0) {
    // Findings named nothing we produced: refine the plot arc as the spine.
    const arcId = producedIds[0];
    if (arcId !== undefined) {
      const arc = await getArtifact(arcId);
      if (arc !== undefined && arc.kind !== 'note') {
        const arcPersona = personaBySlug(personas, slugForKind[arc.kind] ?? FORGE_SLUGS.arc);
        steps.push({
          personaId: arcPersona.id,
          title: `Refine: "${arc.name}"`,
          brief: [
            `A continuity review flagged the module's ${arc.kind} "${arc.name}".`,
            `Its current summary: ${arc.summary}`,
            'Findings to fix:',
            findings,
            'Produce a corrected, self-consistent version that resolves every finding.',
          ].join('\n'),
          autonomy: 'auto',
        });
      }
    }
  }

  return steps;
}

/** The forge singleton used by the Writers' room UI (mirrors chainRunner). */
export const moduleForge = new ModuleForge();
