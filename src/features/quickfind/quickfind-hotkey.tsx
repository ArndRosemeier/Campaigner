import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { artifactPath, campaignIdFromPath, modulePath } from '@/app/routes';
import { listArtifactsByCampaign, listGlobalArtifacts } from '@/db/artifactRepo';
import { listModulesByCampaign } from '@/db/moduleRepo';
import { readSettings } from '@/db/settingsRepo';
import type { AnyArtifact, Module } from '@/domain';
import { toastError } from '@/lib/toast';
import { QuickFindDialog } from '@/features/quickfind/quickfind-dialog';
import { quickFindGoToEntries } from '@/features/quickfind/go-to';
import { useQuickFindStore } from '@/features/quickfind/quickfindStore';

/**
 * App-mounted Ctrl+K quick-find (07-MILESTONE-3 M3-C): listens globally,
 * resolves the campaign from the URL, and dispatches picks — in play mode a
 * pick sets the focus, in the workspace it opens the artifact editor; a
 * module/part pick navigates to the reader and scrolls (08-M4-D).
 */
export function QuickFindHotkey(): JSX.Element | null {
  const { pathname } = useLocation();
  const open = useQuickFindStore((state) => state.open);
  const openQuickFind = useQuickFindStore((state) => state.openQuickFind);
  const close = useQuickFindStore((state) => state.close);
  const campaignId = campaignIdFromPath(pathname);

  useEffect(() => {
    function onKeyDown(event: Event): void {
      // A window-level listener receives whatever is dispatched under the
      // 'keydown' type — not every such event is a real KeyboardEvent (e.g.
      // synthetic plain Events), and assuming so crashes here (runtime
      // `event.key` undefined despite the DOM type saying string).
      if (!(event instanceof KeyboardEvent)) return;
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

  if (!open) return null;
  return <QuickFindResults campaignId={campaignId} close={close} />;
}

/**
 * Mount search queries only after Ctrl+K opens the dialog, and render the
 * dialog only after their initial Dexie emissions settle. This prevents a
 * result node from being replaced between a pointer-down and click.
 */
function QuickFindResults(props: {
  campaignId: string;
  close: () => void;
}): JSX.Element | null {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [snapshot, setSnapshot] = useState<{
    artifacts: AnyArtifact[];
    modules: Module[];
  }>();

  useEffect(() => {
    let cancelled = false;
    void loadQuickFindSnapshot(props.campaignId)
      .then((loaded) => {
        if (!cancelled) setSnapshot(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled) toastError('Could not load quick find', error);
      });
    return () => {
      cancelled = true;
    };
  }, [props.campaignId]);

  if (snapshot === undefined) return null;

  return (
    <QuickFindDialog
      open
      onOpenChange={(next) => {
        if (!next) props.close();
      }}
      artifacts={snapshot.artifacts}
      modules={snapshot.modules}
      mode="workspace"
      goTo={quickFindGoToEntries(props.campaignId, pathname)}
      onGoTo={(to) => {
        props.close();
        navigate(to);
      }}
      onWorkspaceArtifact={(artifact) => {
        props.close();
        navigate(artifactPath(props.campaignId, artifact.id));
      }}
      onPickModule={(moduleId, partIndex) => {
        props.close();
        navigate(modulePath(props.campaignId, moduleId, partIndex));
      }}
    />
  );
}

async function loadQuickFindSnapshot(campaignId: string): Promise<{
  artifacts: AnyArtifact[];
  modules: Module[];
}> {
  const [owned, settings, modules] = await Promise.all([
    listArtifactsByCampaign(campaignId),
    readSettings(),
    listModulesByCampaign(campaignId),
  ]);
  const scopes = settings.artifactScopes.workspace;
  const artifacts: AnyArtifact[] = owned.filter((artifact) =>
    artifact.moduleId !== null ? scopes.module : scopes.campaign,
  );
  if (scopes.global) artifacts.push(...(await listGlobalArtifacts()));
  return { artifacts, modules };
}
