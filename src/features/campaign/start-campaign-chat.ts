import { canvasChatPath } from '@/app/routes';
import { campaignRepo } from '@/db';
import type { Campaign } from '@/domain';
import { startCampaignDocument } from '@/llm/moduleGen';

/** The placeholder name a campaign gets before the owner names it (edit dialog). */
export const NEW_CAMPAIGN_NAME = 'New campaign';

/** Default game system of a campaign created with no form (docs/17 row 395). */
export const DEFAULT_CAMPAIGN_SYSTEM = 'generic-d20' as const;

/**
 * THE campaign entry (docs/17 row 395): creating a campaign is ONE action with
 * no settings. It writes the campaign, its EMPTY document through the one
 * creation seam (`llm/moduleGen.startCampaignDocument`, no input) and returns
 * the canvas-chat path to navigate to. No model call happens here.
 */
export async function createCampaignAndChatPath(name?: string): Promise<string> {
  // An empty / whitespace-only field means "the owner did not name it": the
  // placeholder is a genuine user-preference default (docs/17 row 398), NOT a
  // masked failure. A non-empty name that fails validation still throws in
  // createCampaign and surfaces via the caller's toastError.
  const typed = name?.trim() ?? '';
  const campaign = await campaignRepo.createCampaign({
    name: typed === '' ? NEW_CAMPAIGN_NAME : typed,
    description: '',
    system: DEFAULT_CAMPAIGN_SYSTEM,
  });
  return documentChatPath(campaign);
}

/** Creates the empty document of a campaign that has none; returns the chat path. */
export async function documentChatPath(campaign: Campaign): Promise<string> {
  const moduleId = await startCampaignDocument(campaign);
  return canvasChatPath(campaign.id, moduleId);
}
