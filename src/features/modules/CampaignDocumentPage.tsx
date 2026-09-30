import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';

import { modulePath } from '@/app/routes';
import { getCampaign } from '@/db/campaignRepo';
import { useModules } from '@/features/modules/hooks';
import { documentChatPath } from '@/features/campaign/start-campaign-chat';
import { toastError } from '@/lib/toast';

/**
 * THE CAMPAIGN'S ONE DOCUMENT (docs/23 §10, docs/17 rows 389 and 395).
 *
 * Two states, and NEITHER is a form: the campaign has a document → `Navigate`
 * to its reader; the campaign has NO document → create the empty document
 * through `startCampaignDocument` and land in the canvas chat. Nothing is asked
 * (the levels, tone and premise are all authored in the chat).
 */
export function CampaignDocumentPage(): JSX.Element {
  const { campaignId = '' } = useParams<{ campaignId: string }>();
  const navigate = useNavigate();
  const modules = useModules(campaignId === '' ? undefined : campaignId);
  const campaign = useLiveQuery(
    async () => (campaignId === '' ? undefined : await getCampaign(campaignId)),
    [campaignId],
  );
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  const document = modules?.[0];
  const needsDocument = modules !== undefined && campaign !== undefined && document === undefined;
  useEffect(() => {
    if (!needsDocument || started.current) return;
    started.current = true;
    documentChatPath(campaign)
      .then((path) => {
        navigate(path, { replace: true });
      })
      .catch((error: unknown) => {
        setFailed(true);
        toastError('The campaign document could not be started', error);
      });
  }, [needsDocument, campaign, navigate]);

  if (document !== undefined) {
    return <Navigate to={modulePath(campaignId, document.id)} replace />;
  }
  if (failed) {
    return (
      <p className="p-6 text-sm text-destructive" data-testid="campaign-document-failed">
        The campaign document could not be started.
      </p>
    );
  }
  return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
}
