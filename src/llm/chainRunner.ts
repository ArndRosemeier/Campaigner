import type { Autonomy, Campaign, Id, Persona, PersonaRun } from '@/domain';
import { runEngine, waitForRunStatus, type StartRunInput } from '@/llm/runEngine';

/**
 * Writers' room (06-MILESTONES M2: persona chaining) — runs a sequence of
 * personas in order, feeding each run the artifacts produced by the previous
 * steps as context. Each chain step is a real PersonaRun (visible in the Runs
 * tab, pause semantics identical to a solo run); when a run pauses for the
 * user, the chain waits and resumes once the run completes.
 */

export interface ChainStepInput {
  personaId: Id;
  brief: string;
  /**
   * Human-readable step label shown in the progress list ("Key location 1").
   * Optional — custom pipeline steps without one fall back to "Step N".
   */
  title?: string;
  /** Per-step autonomy override (falls back to the chain-wide autonomy). */
  autonomy?: Autonomy;
  /**
   * Review steps only: which produced artifact to review. 'first' targets
   * the first artifact of the chain (the module's plot arc), 'last' the most
   * recent one. Ignored for generate personas.
   */
  reviewTarget?: 'first' | 'last';
}

/** Autonomy for a step: the explicit override wins over the chain default. */
function autonomyFor(step: ChainStepInput | undefined, chainAutonomy: Autonomy): Autonomy {
  return step?.autonomy ?? chainAutonomy;
}

/** The review target for a review-persona step, from artifacts so far. */
function reviewTargetId(step: ChainStepInput | undefined, produced: readonly Id[]): Id | undefined {
  if (step?.reviewTarget === 'first') return produced[0];
  if (step?.reviewTarget === 'last') return produced[produced.length - 1];
  return produced[produced.length - 1];
}

export type ChainStepStatus =
  'pending' | 'running' | 'awaiting_user' | 'needs_review' | 'completed' | 'failed' | 'cancelled';

export interface ChainStepState {
  runId: Id | null;
  status: ChainStepStatus;
  artifactId: Id | null;
  /** From the step input; null for custom pipeline steps (UI falls back). */
  title: string | null;
}

export interface ChainState {
  steps: ChainStepState[];
  /** Index of the step the chain is currently on, or steps.length when done. */
  currentIndex: number;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
}

type ChainListener = (state: ChainState) => void;

function stepStatusForRun(run: PersonaRun): ChainStepStatus {
  switch (run.status) {
    case 'running':
      return 'running';
    case 'awaiting_user':
      return 'awaiting_user';
    case 'needs_review':
      return 'needs_review';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

export class ChainRunner {
  private listeners = new Set<ChainListener>();
  private state: ChainState = { steps: [], currentIndex: 0, status: 'idle' };
  private cancelRequested = false;
  /** Inputs needed to resume a paused chain. */
  private resumeArgs: {
    campaign: Campaign;
    personas: readonly Persona[];
    steps: readonly ChainStepInput[];
    autonomy: Autonomy;
    pinnedChunkIds: readonly Id[];
  } | null = null;

  on(listener: ChainListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot: ChainState = {
      steps: this.state.steps.map((step) => ({ ...step })),
      currentIndex: this.state.currentIndex,
      status: this.state.status,
    };
    this.state = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  getState(): ChainState {
    return this.state;
  }

  reset(): void {
    this.cancelRequested = false;
    this.resumeArgs = null;
    this.state = { steps: [], currentIndex: 0, status: 'idle' };
    this.emit();
  }

  cancel(): void {
    this.cancelRequested = true;
  }

  /**
   * Runs the chain. Resolves when the chain reaches a terminal state
   * (completed / failed / cancelled) — a paused chain keeps waiting for the
   * user to finish its run through the Assistant tab. `cancel()` is honored
   * mid-pass: after each step's run settles, a requested cancel ends the
   * chain as 'cancelled' instead of starting the next step (the initial
   * pass previously skipped this check, so Stop only worked on resumed
   * passes). Delegates to runRemaining so there is ONE per-step sequence.
   */
  async run(
    campaign: Campaign,
    personas: readonly Persona[],
    steps: readonly ChainStepInput[],
    autonomy: Autonomy,
    pinnedChunkIds: readonly Id[],
  ): Promise<ChainState> {
    this.cancelRequested = false;
    this.state = {
      steps: steps.map((stepInput) => ({
        runId: null,
        status: 'pending' as const,
        artifactId: null,
        title: stepInput.title ?? null,
      })),
      currentIndex: 0,
      status: 'running',
    };
    this.emit();
    return this.runRemaining(campaign, personas, steps, autonomy, pinnedChunkIds, 0, []);
  }

  /**
   * Continues a paused chain: waits for the user to resolve the paused run
   * (via the Assistant tab), then runs the remaining steps.
   */
  async resume(): Promise<ChainState> {
    if (this.resumeArgs === null) return this.state;
    const pausedIndex = this.state.steps.findIndex(
      (step) => step.status === 'awaiting_user' || step.status === 'needs_review',
    );
    const pausedStep = this.state.steps[pausedIndex];
    if (pausedStep === undefined || pausedIndex === -1 || pausedStep.runId === null) {
      return this.state;
    }
    this.state.status = 'running';
    this.emit();

    const producedArtifactIds: Id[] = [];
    for (const step of this.state.steps) {
      const artifactId = step.artifactId;
      if (artifactId !== null) producedArtifactIds.push(artifactId);
    }

    const outcome = await waitForRunStatus(pausedStep.runId);
    this.state.steps[pausedIndex] = {
      runId: pausedStep.runId,
      status: stepStatusForRun(outcome),
      artifactId: outcome.resultArtifactId,
      title: pausedStep.title,
    };
    this.emit();

    if (outcome.status === 'completed' && outcome.resultArtifactId !== null) {
      producedArtifactIds.push(outcome.resultArtifactId);
    } else {
      this.state.status = outcome.status === 'cancelled' ? 'cancelled' : 'failed';
      this.emit();
      return this.state;
    }

    return this.runRemaining(
      this.resumeArgs.campaign,
      this.resumeArgs.personas,
      this.resumeArgs.steps,
      this.resumeArgs.autonomy,
      this.resumeArgs.pinnedChunkIds,
      pausedIndex + 1,
      producedArtifactIds,
    );
  }

  /**
   * Resumes a FAILED chain from its failed step (00-OVERVIEW: a run that
   * failed at one step is resumable, not restartable). The failed run stays
   * in the Runs tab with its error message; retry starts a NEW run for that
   * step — fed the artifacts of every completed step before it as context —
   * and then runs the remaining steps.
   */
  async retry(): Promise<ChainState> {
    if (this.resumeArgs === null || this.state.status !== 'failed') return this.state;
    const failedIndex = this.state.steps.findIndex((step) => step.status === 'failed');
    const failedStep = this.state.steps[failedIndex];
    if (failedIndex === -1 || failedStep === undefined) return this.state;

    const args = this.resumeArgs;
    this.state.status = 'running';
    this.emit();

    // Prior work feeds the retried step as context — nothing is wasted.
    const producedArtifactIds = this.state.steps
      .slice(0, failedIndex)
      .map((step) => step.artifactId)
      .filter((id): id is Id => id !== null);

    return this.runRemaining(
      args.campaign,
      args.personas,
      args.steps,
      args.autonomy,
      args.pinnedChunkIds,
      failedIndex,
      producedArtifactIds,
    );
  }

  /** Runs steps[fromIndex..] with the given already-produced artifacts. */
  private async runRemaining(
    campaign: Campaign,
    personas: readonly Persona[],
    steps: readonly ChainStepInput[],
    autonomy: Autonomy,
    pinnedChunkIds: readonly Id[],
    fromIndex: number,
    producedArtifactIds: Id[],
  ): Promise<ChainState> {
    this.resumeArgs = { campaign, personas, steps, autonomy, pinnedChunkIds };

    for (let index = fromIndex; index < steps.length; index += 1) {
      const step = steps[index];
      if (step === undefined) break;
      const persona = personas.find((candidate) => candidate.id === step.personaId);
      if (persona === undefined) {
        this.state.steps[index] = { runId: null, status: 'failed', artifactId: null, title: step.title ?? null };
        this.state.status = 'failed';
        this.emit();
        return this.state;
      }

      this.state.currentIndex = index;
      this.state.steps[index] = { runId: null, status: 'running', artifactId: null, title: step.title ?? null };
      this.emit();

      // Image personas decorate an existing artifact via the editor; they
      // never appear in pipelines (07-MILESTONE-3 M3-A).
      if (persona.mode === 'image') {
        throw new Error(`"${persona.name}" is not chainable — illustrate via the artifact editor`);
      }
      if (persona.mode === 'encounter') {
        throw new Error(`"${persona.name}" is not chainable — use the encounter generator`);
      }

      const stepAutonomy = autonomyFor(step, autonomy);
      const input: StartRunInput = {
        campaign,
        persona,
        autonomy: stepAutonomy,
        brief: step.brief,
        pinnedChunkIds,
        contextArtifactIds: producedArtifactIds,
      };
      if (persona.mode === 'review') {
        const targetId = reviewTargetId(step, producedArtifactIds);
        if (targetId !== undefined) input.targetArtifactId = targetId;
      }
      const runId = await runEngine.startRun(input);
      this.state.steps[index] = { runId, status: 'running', artifactId: null, title: step.title ?? null };
      this.emit();

      // Wait for the run to finish or pause for the user (the user resolves
      // paused runs via the Assistant tab; resume() continues the chain).
      const outcome = await waitForRunStatus(runId, { includePaused: true });
      this.state.steps[index] = {
        runId,
        status: stepStatusForRun(outcome),
        artifactId: outcome.resultArtifactId,
        title: step.title ?? null,
      };
      this.emit();

      if (outcome.status === 'cancelled') {
        this.state.status = 'cancelled';
        this.emit();
        return this.state;
      }
      if (this.cancelRequested) {
        this.state.status = 'cancelled';
        this.emit();
        return this.state;
      }
      if (outcome.status === 'failed') {
        this.state.status = 'failed';
        this.emit();
        return this.state;
      }
      if (outcome.status !== 'completed' || outcome.resultArtifactId === null) {
        this.state.status = 'paused';
        this.emit();
        return this.state;
      }

      producedArtifactIds.push(outcome.resultArtifactId);
    }

    this.state.currentIndex = steps.length;
    this.state.status = 'completed';
    this.emit();
    return this.state;
  }
}

/** The writers'-room singleton used by the panel. */
export const chainRunner = new ChainRunner();
