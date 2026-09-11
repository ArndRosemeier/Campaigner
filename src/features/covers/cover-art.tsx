import type { JSX } from 'react';
import { RefreshCwIcon, SparklesIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { WriterModelId } from '@/components/writer-model-id';
import type { Campaign, Id, Module } from '@/domain';
import { getSettings } from '@/db/settingsRepo';
import { useImageModel } from '@/features/images/use-image-model';
import { useImageUrl } from '@/features/images/use-image-url';
import {
  enqueueCampaignCover,
  enqueueModuleCover,
  regenerateCampaignCover,
  regenerateModuleCover,
} from '@/features/covers/cover-image-queue';
import { toastError } from '@/lib/toast';

/**
 * Module/campaign cover art (cover-generation arc): every display resolves
 * its slot through `useImageUrl(coverImageId)` — the SAME artifact-cover
 * path as the play cards (`Portrait`), the peek modal and the lightbox —
 * and renders nothing while loading/missing (no placeholder art, never a
 * silent stand-in).
 *
 * GM operation note: these surfaces never render in player-safe mode (the
 * battle player-safe DOM contract mounts board material only) and the
 * reader's every other control is already an un-gated GM control — so the
 * Generate buttons below join that same set with no extra gate. The
 * player-audience PDF strips GM-only material at render; covers are shared
 * art, never secrets.
 */

/** Small list-row thumb for a module (ModulesListPage). Null without art. */
export function ModuleCoverThumb({ module }: { module: Module }): JSX.Element | null {
  const url = useImageUrl(module.coverImageId);
  if (url === null) return null;
  // No caption here: a 40px row thumb cannot render a model id legibly, and
  // the reader's hero shows the same cover with it (provenance arc decision).
  return (
    <img
      src={url}
      alt={`Cover art for ${module.title}`}
      className="size-10 shrink-0 rounded-md object-cover"
      data-testid="module-cover-thumb"
    />
  );
}

/**
 * PROVENANCE (docs/17 row 93): "a small id below images indicating the image
 * model" — the caption for a cover slot, resolved from the SAME
 * `useImageUrl` boundary every cover display already uses (one live query per
 * row, no new plumbing). `''`/missing renders NOTHING: an upload, or a cover
 * generated before the field, shows no id.
 */
function CoverModelCaption({ imageId, testId }: { imageId: Id | null; testId: string }): JSX.Element | null {
  const model = useImageModel(imageId);
  return <WriterModelId model={model} testId={testId} label="Image model" />;
}

/** Wide header hero for a module (ModuleReaderPage). Null without art. */
export function ModuleCoverHero({ module }: { module: Module }): JSX.Element | null {
  const url = useImageUrl(module.coverImageId);
  if (url === null) return null;
  return (
    <figure className="mb-2">
      <img
        src={url}
        alt={`Cover art for ${module.title}`}
        className="h-48 w-full rounded-lg object-cover"
        data-testid="module-cover-hero"
      />
      <CoverModelCaption imageId={module.coverImageId} testId="module-cover-hero-model" />
    </figure>
  );
}

/** Card art for a campaign (CampaignPickerPage). Null without art. */
export function CampaignCoverArt({ campaign }: { campaign: Campaign }): JSX.Element | null {
  const url = useImageUrl(campaign.coverImageId);
  if (url === null) return null;
  return (
    <figure>
      <img
        src={url}
        alt={`Cover art for ${campaign.name}`}
        className="h-32 w-full rounded-md object-cover"
        data-testid="campaign-cover-art"
      />
      <CoverModelCaption imageId={campaign.coverImageId} testId="campaign-cover-art-model" />
    </figure>
  );
}

/** Generate / Regenerate the module cover (unattended queue; dock carries progress). */
export function GenerateModuleCoverButton({
  module,
  compact = false,
}: {
  module: Module;
  /** Icon-only (list rows) vs labeled (headers, cards). Same action, same testid. */
  compact?: boolean;
}): JSX.Element {
  const regenerating = module.coverImageId !== null;
  if (compact) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        data-testid="module-cover-generate"
        aria-label={regenerating ? `Regenerate cover for ${module.title}` : `Generate cover for ${module.title}`}
        title={regenerating ? 'Regenerate cover' : 'Generate cover'}
        onClick={() => {
          void queueModuleCover(module);
        }}
      >
        {regenerating ? <RefreshCwIcon aria-hidden /> : <SparklesIcon aria-hidden />}
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      size="xs"
      data-testid="module-cover-generate"
      aria-label={regenerating ? `Regenerate cover for ${module.title}` : `Generate cover for ${module.title}`}
      onClick={() => {
        void queueModuleCover(module);
      }}
    >
      {regenerating ? (
        <RefreshCwIcon aria-hidden data-icon="inline-start" />
      ) : (
        <SparklesIcon aria-hidden data-icon="inline-start" />
      )}
      {regenerating ? 'Regenerate cover' : 'Generate cover'}
    </Button>
  );
}

/** Generate / Regenerate the campaign cover (unattended queue; dock carries progress). */
export function GenerateCampaignCoverButton({
  campaign,
  compact = false,
}: {
  campaign: Campaign;
  /** Icon-only vs labeled. Same action, same testid. */
  compact?: boolean;
}): JSX.Element {
  const regenerating = campaign.coverImageId !== null;
  if (compact) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        data-testid="campaign-cover-generate"
        aria-label={regenerating ? `Regenerate cover for ${campaign.name}` : `Generate cover for ${campaign.name}`}
        title={regenerating ? 'Regenerate cover' : 'Generate cover'}
        onClick={() => {
          void queueCampaignCover(campaign);
        }}
      >
        {regenerating ? <RefreshCwIcon aria-hidden /> : <SparklesIcon aria-hidden />}
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      size="xs"
      data-testid="campaign-cover-generate"
      aria-label={regenerating ? `Regenerate cover for ${campaign.name}` : `Generate cover for ${campaign.name}`}
      onClick={() => {
        void queueCampaignCover(campaign);
      }}
    >
      {regenerating ? (
        <RefreshCwIcon aria-hidden data-icon="inline-start" />
      ) : (
        <SparklesIcon aria-hidden data-icon="inline-start" />
      )}
      {regenerating ? 'Regenerate cover' : 'Generate cover'}
    </Button>
  );
}

async function queueModuleCover(module: Module): Promise<void> {
  await queueCoverGuard(() => {
    if (module.coverImageId === null) {
      enqueueModuleCover(module.id, module.campaignId, module.title);
    } else {
      regenerateModuleCover(module.id, module.campaignId, module.title);
    }
  }, 'Could not queue the module cover');
}

async function queueCampaignCover(campaign: Campaign): Promise<void> {
  await queueCoverGuard(() => {
    if (campaign.coverImageId === null) {
      enqueueCampaignCover(campaign.id, campaign.name);
    } else {
      regenerateCampaignCover(campaign.id, campaign.name);
    }
  }, 'Could not queue the campaign cover');
}

/** Loud when image generation is disabled or the enqueue itself throws —
 * silent otherwise (the app-wide progress dock carries the feedback, the
 * mob-queue entry-point precedent). */
async function queueCoverGuard(work: () => void, title: string): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.imagesEnabled) {
      throw new Error('Image generation is disabled — enable it in Settings');
    }
    work();
  } catch (error) {
    toastError(title, error);
  }
}
