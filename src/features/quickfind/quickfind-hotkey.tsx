import { useEffect } from 'react';
import type { JSX } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';

import { ROUTES, artifactPath, campaignIdFromPath } from '@/app/routes';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { usePlayStore } from '@/features/play/playStore';
import { QuickFindDialog } from '@/features/quickfind/quickfind-dialog';
import { useQuickFindStore } from '@/features/quickfind/quickfindStore';

/**
 * App-mounted Ctrl+K quick-find (07-MILESTONE-3 M3-C): listens globally,
 * resolves the campaign from the URL, and dispatches picks — in play mode a
 * pick sets the focus, in the workspace it opens the artifact editor.
 */
export function QuickFindHotkey(): JSX.Element | null {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const open = useQuickFindStore((state) => state.open);
  const openQuickFind = useQuickFindStore((state) => state.openQuickFind);
  const close = useQuickFindStore((state) => state.close);
  const setFocus = usePlayStore((state) => state.setFocus);
  const campaignId = campaignIdFromPath(pathname);
  const playMode = matchPlay(pathname);
  const artifacts = useLiveQuery(
    () => (campaignId === undefined ? Promise.resolve([]) : listArtifactsByCampaign(campaignId)),
    [campaignId],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey)) return;
      if (campaignId === undefined) return;
      event.preventDefault();
      openQuickFind();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [campaignId, openQuickFind]);

  if (campaignId === undefined) return null;

  return (
    <QuickFindDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      artifacts={artifacts ?? []}
      mode={playMode ? 'play' : 'workspace'}
      onPickArtifact={(artifact) => {
        setFocus(campaignId, artifact.id);
      }}
      onWorkspaceArtifact={(artifact) => {
        close();
        navigate(artifactPath(campaignId, artifact.id));
      }}
    />
  );
}

function matchPlay(pathname: string): boolean {
  return matchPath(ROUTES.play, pathname) !== null;
}
