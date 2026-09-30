import { canvasChatPath } from '@/app/routes';
import { campaignRepo } from '@/db';
import type { Campaign, GameSystem } from '@/domain';
import { startCampaignDocument } from '@/llm/moduleGen';

/** The placeholder name a campaign gets before the owner names it (edit dialog). */
export const NEW_CAMPAIGN_NAME = 'New campaign';

/**
 * The system the new-campaign picker STARTS on (docs/17 row 416): a genuine
 * preference default for the control — the owner picks the real one beside
 * the New Campaign button, and the creation below takes it explicitly.
 */
export const DEFAULT_CAMPAIGN_SYSTEM: GameSystem = 'generic-d20';

/**
 * THE campaign entry (docs/17 row 395): creating a campaign is ONE action. Its
 * two inputs sit beside the button — the name (row 398) and the game system
 * (row 416; the system is fixed after creation, so it must be chosen here). It
 * writes the campaign, its EMPTY document through the one
 * creation seam (`llm/moduleGen.startCampaignDocument`, no input) and returns
 * the canvas-chat path to navigate to. No model call happens here.
 */
export async function createCampaignAndChatPath(name: string, system: GameSystem): Promise<string> {
  // An empty / whitespace-only field means "the owner did not name it": the
  // placeholder is a genuine user-preference default (docs/17 row 398), NOT a
  // masked failure. A non-empty name that fails validation still throws in
  // createCampaign and surfaces via the caller's toastError.
  const typed = name.trim();
  const campaign = await campaignRepo.createCampaign({
    name: typed === '' ? NEW_CAMPAIGN_NAME : typed,
    description: '',
    system,
  });
  return documentChatPath(campaign);
}

/** Creates the empty document of a campaign that has none; returns the chat path. */
export async function documentChatPath(campaign: Campaign): Promise<string> {
  const moduleId = await startCampaignDocument(campaign);
  return canvasChatPath(campaign.id, moduleId);
}
