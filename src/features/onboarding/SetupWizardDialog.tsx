import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2Icon, ChevronDownIcon, CircleDashed, MinusCircleIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { toastError } from '@/lib/toast';
import { ONBOARDING_STEP_IDS, type OnboardingStepId } from '@/domain';
import { WIZARD_STEPS, wizardStep } from '@/features/onboarding/onboardingContent';
import {
  firstUnresolvedStepId,
  setOnboardingStatus,
  setOnboardingStep,
} from '@/features/onboarding/onboardingState';
import { useOnboardingStore } from '@/features/onboarding/onboardingStore';
import { useOnboardingProgress } from '@/features/onboarding/useOnboardingProgress';

/**
 * First-run setup wizard (05-UI.md §Onboarding): a CHECKLIST, not a stepper —
 * six steps that link out to the EXISTING surfaces (Settings, Rules, the
 * campaign picker) and track completion instead of re-implementing anything.
 * Every step is skippable; progress persists in the settings row and the
 * dialog resumes at the first unresolved step. Detection signals (saved key,
 * imported book, created campaign+module) tick a pending step automatically.
 */

export function SetupWizardDialog(): JSX.Element | null {
  const open = useOnboardingStore((state) => state.open);
  const focusStep = useOnboardingStore((state) => state.focusStep);
  const closeWizard = useOnboardingStore((state) => state.closeWizard);
  const navigate = useNavigate();
  const progress = useOnboardingProgress();

  const [expanded, setExpanded] = useState<OnboardingStepId | null>(null);
  const [finishing, setFinishing] = useState(false);

  // Focus on open: an explicit focus step always wins (openWizard(focus) may
  // arrive while the dialog is already open); without one, expand the first
  // unresolved step once the settings row is available.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!open || progress.settings === undefined) return;
    if (focusStep !== null) {
      setExpanded(focusStep);
      return;
    }
    if (initializedRef.current) return;
    initializedRef.current = true;
    setExpanded(firstUnresolvedStepId(progress.onboarding));
  }, [open, focusStep, progress.settings, progress.onboarding]);
  useEffect(() => {
    if (!open) initializedRef.current = false;
  }, [open]);

  // Persist detection transitions (pending → done) exactly once each.
  const persistingRef = useRef<Set<OnboardingStepId>>(new Set());
  useEffect(() => {
    for (const entry of progress.pendingPersist) {
      if (persistingRef.current.has(entry.id)) continue;
      persistingRef.current.add(entry.id);
      void setOnboardingStep(entry.id, entry.state)
        .catch((error: unknown) => {
          toastError('Could not save setup progress', error);
        })
        .finally(() => {
          persistingRef.current.delete(entry.id);
        });
    }
  }, [progress.pendingPersist]);

  if (!open) return null;

  const allResolved = progress.steps.every((step) => step.effective !== 'pending');

  async function resolveStep(id: OnboardingStepId, state: 'done' | 'skipped'): Promise<void> {
    try {
      await setOnboardingStep(id, state);
    } catch (error) {
      toastError('Could not save setup progress', error);
    }
    advanceFocus(id);
  }

  function advanceFocus(from: OnboardingStepId): void {
    const index = ONBOARDING_STEP_IDS.indexOf(from);
    for (const id of ONBOARDING_STEP_IDS.slice(index + 1)) {
      const step = progress.steps.find((entry) => entry.id === id);
      if (step?.effective === 'pending') {
        setExpanded(id);
        return;
      }
    }
    setExpanded(null);
  }

  function openLink(route: string): void {
    closeWizard();
    navigate(route);
  }

  async function finish(): Promise<void> {
    setFinishing(true);
    try {
      await setOnboardingStatus('complete');
      closeWizard();
    } catch (error) {
      toastError('Could not save setup progress', error);
    } finally {
      setFinishing(false);
    }
  }

  async function dismiss(): Promise<void> {
    try {
      await setOnboardingStatus('dismissed');
    } catch (error) {
      toastError('Could not save setup progress', error);
    }
    closeWizard();
  }

  const doneCount = progress.steps.filter((step) => step.effective !== 'pending').length;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeWizard();
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
        data-testid="setup-wizard"
      >
        <DialogHeader className="border-b p-4">
          <DialogTitle className="text-base">Set up Campaigner</DialogTitle>
          <DialogDescription>
            First run: about five minutes, one key, your data stays local. Leave anytime — the
            wizard resumes where you left off ({doneCount} of {String(WIZARD_STEPS.length)}{' '}
            resolved).
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <ul className="flex flex-col gap-1.5">
            {progress.steps.map((step) => {
              const content = wizardStep(step.id);
              const isExpanded = expanded === step.id;
              return (
                <li
                  key={step.id}
                  className={cn(
                    'rounded-md border',
                    isExpanded ? 'border-ring' : 'border-transparent',
                  )}
                  data-testid={`wizard-step-${step.id}`}
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent"
                    aria-expanded={isExpanded}
                    onClick={() => {
                      setExpanded(isExpanded ? null : step.id);
                    }}
                    data-testid={`wizard-row-${step.id}`}
                  >
                    <StepStateIcon state={step.effective} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {content.title}
                    </span>
                    {content.optional && <Badge variant="outline">optional</Badge>}
                    <ChevronDownIcon
                      aria-hidden
                      className={cn('size-4 text-muted-foreground transition-transform', isExpanded && 'rotate-180')}
                    />
                  </button>

                  {isExpanded && (
                    <div className="flex flex-col gap-2 px-3 pb-3">
                      {content.sections.map((section, index) => (
                        <p key={index} className="text-sm text-muted-foreground">
                          {section.heading !== '' && (
                            <span className="font-medium text-foreground">{section.heading}: </span>
                          )}
                          {section.text}
                        </p>
                      ))}
                      {content.bullets.length > 0 && (
                        <ul className="flex flex-col gap-1">
                          {content.bullets.map((bullet, index) => (
                            <li key={index} className="flex gap-2 text-sm">
                              <span
                                aria-hidden
                                className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
                              />
                              <span>{bullet}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {step.authorProgress !== undefined && (
                        <ul className="flex flex-col gap-1 text-sm">
                          <li
                            className={cn(
                              step.authorProgress.campaign
                                ? 'text-emerald-600'
                                : 'text-muted-foreground',
                            )}
                            data-testid="wizard-detail-campaign"
                          >
                            {step.authorProgress.campaign ? '✓ ' : '· '}
                            Campaign created
                          </li>
                          <li
                            className={cn(
                              step.authorProgress.module
                                ? 'text-emerald-600'
                                : 'text-muted-foreground',
                            )}
                            data-testid="wizard-detail-module"
                          >
                            {step.authorProgress.module ? '✓ ' : '· '}
                            Module created
                          </li>
                        </ul>
                      )}
                      {content.links.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {content.links.map((link) => {
                            const route = link.route;
                            return route !== undefined ? (
                              <Button
                                key={link.testid}
                                variant="outline"
                                size="sm"
                                data-testid={link.testid}
                                onClick={() => {
                                  openLink(route);
                                }}
                              >
                                {link.label}
                              </Button>
                            ) : (
                              <a
                                key={link.testid}
                                href={link.href}
                                target="_blank"
                                rel="noreferrer"
                                data-testid={link.testid}
                                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                              >
                                {link.label}
                              </a>
                            );
                          })}
                        </div>
                      )}
                      {step.id === 'welcome' ? (
                        <div>
                          <Button
                            size="sm"
                            data-testid="wizard-begin"
                            onClick={() => {
                              void resolveStep('welcome', 'done');
                            }}
                          >
                            Begin
                          </Button>
                        </div>
                      ) : (
                        step.effective === 'pending' && (
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              data-testid={`wizard-done-${step.id}`}
                              onClick={() => {
                                void resolveStep(step.id, 'done');
                              }}
                            >
                              Mark done
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              data-testid={`wizard-skip-${step.id}`}
                              onClick={() => {
                                void resolveStep(step.id, 'skipped');
                              }}
                            >
                              Skip
                            </Button>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex items-center gap-2 border-t p-3">
          <Button
            variant="ghost"
            size="sm"
            data-testid="wizard-dismiss"
            onClick={() => {
              void dismiss();
            }}
          >
            Don’t show again
          </Button>
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            data-testid="wizard-close"
            onClick={closeWizard}
          >
            Close
          </Button>
          <Button
            size="sm"
            data-testid="wizard-finish"
            disabled={!allResolved || finishing}
            onClick={() => {
              void finish();
            }}
          >
            Finish
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StepStateIcon({ state }: { state: 'pending' | 'done' | 'skipped' }): JSX.Element {
  if (state === 'done') {
    return <CheckCircle2Icon aria-label="done" className="size-4 shrink-0 text-emerald-500" />;
  }
  if (state === 'skipped') {
    return <MinusCircleIcon aria-label="skipped" className="size-4 shrink-0 text-muted-foreground" />;
  }
  return <CircleDashed aria-label="pending" className="size-4 shrink-0 text-muted-foreground" />;
}
