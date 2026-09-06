import { ROUTES } from '@/app/routes';

import type { OnboardingStepId } from '@/domain';

/**
 * Single source of truth for the first-run setup wizard's step copy (plain
 * data, like /src/help/helpContent.ts): the SetupWizardDialog renders it and
 * a test guarantees every step stays complete. Each step maps to an EXISTING
 * surface — the wizard links out and tracks completion, it never re-implements
 * ingest UIs. Copy is the banked onboarding design (welcome → OpenRouter →
 * language → rulebook → bestiary pack → first campaign + module).
 */

/** Where a step's completion signal comes from (see useOnboardingProgress). */
export type StepDetection =
  /** Resolves the moment the user presses Begin. */
  | 'begin'
  /** `settings.openRouterApiKey !== ''`. */
  | 'apiKey'
  /** `settings.language !== 'en'` (the default is fine — English users skip). */
  | 'language'
  /** At least one rulebook imported. */
  | 'rulebook'
  /** No cheap signal — manual "Mark done" only (pack rows aren't tagged). */
  | 'pack'
  /** Campaign created AND a module exists. */
  | 'author';

export interface WizardStepLink {
  label: string;
  /** In-app route (from ROUTES) navigated with the router. */
  route?: string;
  /** External URL opened in a new tab (target="_blank" precedent). */
  href?: string;
  testid: string;
}

export interface WizardStep {
  id: OnboardingStepId;
  title: string;
  /** Lede paragraph(s) under the title. */
  sections: { heading: string; text: string }[];
  bullets: string[];
  links: WizardStepLink[];
  /** Optional steps read as "recommended, skippable" — never as noise. */
  optional: boolean;
  detection: StepDetection;
}

export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Campaigner',
    sections: [
      {
        heading: '',
        text: 'A local-first campaign workbench: rulebooks, artifacts, AI personas and printable exports — no account, no server. Everything lives in this browser.',
      },
    ],
    bullets: [
      'Your data never leaves this device.',
      'AI generation runs on your own OpenRouter key — a paid API service.',
      'This wizard takes about 5 minutes; every step links to the screen that does the job.',
    ],
    links: [],
    optional: false,
    detection: 'begin',
  },
  {
    id: 'openrouter',
    title: 'Connect your OpenRouter key',
    sections: [
      {
        heading: 'What it is',
        text: 'Campaigner doesn’t run its own AI. It sends prompts to OpenRouter, a paid API service where one key gives you hundreds of models. The default chat model (Claude Sonnet) costs ~$3 per million tokens — a typical run costs a few cents.',
      },
      {
        heading: 'Get one',
        text: 'Create a key at openrouter.ai/keys: sign up, add a few dollars of credit, press “Create key”, copy it (starts with sk-or-).',
      },
      {
        heading: 'Paste it',
        text: 'Settings → OpenRouter → API key → Save, then press “Test key” — you should see “Key works”.',
      },
      {
        heading: 'Privacy',
        text: 'The key is stored only in this browser and is sent only to openrouter.ai. Campaigner has no backend.',
      },
    ],
    bullets: [],
    links: [
      { label: 'Open Settings', route: ROUTES.settings, testid: 'wizard-link-settings' },
      { label: 'openrouter.ai/keys', href: 'https://openrouter.ai/keys', testid: 'wizard-link-openrouter-keys' },
    ],
    optional: false,
    detection: 'apiKey',
  },
  {
    id: 'language',
    title: 'Choose your language',
    sections: [
      {
        heading: '',
        text: 'All generated content is written in this language. Default is English; change it here or anytime in the top bar.',
      },
    ],
    bullets: [],
    links: [{ label: 'Open Settings', route: ROUTES.settings, testid: 'wizard-link-settings-language' }],
    optional: true,
    detection: 'language',
  },
  {
    id: 'rulebook',
    title: 'Import a rulebook',
    sections: [
      {
        heading: '',
        text: 'On Rules, press “Import PDFs” and pick a rulebook PDF you own. Books are split into searchable chunks; pinned rule text grounds every persona run. Scanned (image-only) PDFs fail loudly — use text PDFs. Original files are never stored, so deleting a book needs the file again.',
      },
    ],
    bullets: [],
    links: [{ label: 'Open Rules', route: ROUTES.rules, testid: 'wizard-link-rules' }],
    optional: true,
    detection: 'rulebook',
  },
  {
    id: 'pack',
    title: 'Fetch a bestiary pack',
    sections: [
      {
        heading: '',
        text: 'Settings → Bestiary packs: one-click download of machine-readable monster books (D&D 5e / Pathfinder 2e) from pinned upstream repos. Fetched packs behave exactly like imported books and power encounter rosters. Re-fetch anytime; the manual file import stays in Rules.',
      },
    ],
    bullets: [],
    links: [{ label: 'Open Settings', route: ROUTES.settings, testid: 'wizard-link-settings-pack' }],
    optional: true,
    detection: 'pack',
  },
  {
    id: 'author',
    title: 'Create your first campaign and module',
    sections: [
      {
        heading: '',
        text: 'The campaign holds your artifacts and its game system (used by stat blocks and battles). Then press “Module” in the top bar: Campaigner drafts a premise + part plan — the spine — for your approval, then writes the parts one by one.',
      },
    ],
    bullets: ['New to module authoring? Open the guide — it walks the whole path, end to end.'],
    links: [{ label: 'New campaign', route: ROUTES.campaignPicker, testid: 'wizard-link-campaigns' }],
    optional: false,
    detection: 'author',
  },
];

/** The step copy for one id. Throws loudly on an unknown id (no fallbacks). */
export function wizardStep(id: OnboardingStepId): WizardStep {
  const step = WIZARD_STEPS.find((entry) => entry.id === id);
  if (step === undefined) {
    throw new Error(`Unknown onboarding step: ${id}`);
  }
  return step;
}
