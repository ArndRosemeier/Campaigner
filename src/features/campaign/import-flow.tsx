import { useState } from 'react';
import type { JSX } from 'react';

import type { DependencyAnalysis, Id } from '@/domain';
import {
  checkImportDependencies,
  formatDriftedCitations,
  importExport,
  importZip,
  MissingDependenciesError,
  parseExport,
  parseZipExport,
  withImportMitigation,
  type DependencyPolicy,
  type ImportOptions,
  type ImportResult,
} from '@/lib/exportImport';
import {
  ImportDepsDialog,
  type PendingImport,
  type PendingImportPayload,
} from '@/features/campaign/components/import-deps-dialog';
import { toastError, toastInfo, toastSuccess } from '@/lib/toast';

/**
 * THE one campaign-file import flow (docs/17 row 322, AGENTS rule 4), shared by
 * the two surfaces that read a Campaigner export:
 *
 * - the picker (`CampaignPickerPage`) imports the file as a NEW campaign and
 *   lands on it;
 * - the workspace's action bar imports it INTO the campaign you are already in
 *   (`targetCampaignId`), because moving players between campaigns is the
 *   owner's actual need.
 *
 * Parse-first, exactly as before: the file is read (`parseExport` refuses a
 * pre-cut file BY NAME), the dependency manifest is analyzed against the local
 * library BEFORE any transaction opens, and an UNCLEAN analysis opens the ONE
 * `ImportDepsDialog` (Abort by default; "Import anyway" lands the encounters
 * with `missing ref` markers). A clean manifest keeps the one-click path
 * byte-identical. The `version-drift` count rides the success toast
 * (`formatDriftedCitations`) — an unblocked fallback that said nothing would be
 * the silent failure AGENTS rule 1 forbids.
 */
export interface CampaignImportRequest {
  /**
   * The campaign to import INTO. Absent = the picker path: the import mints a
   * NEW campaign (`importZip`/`importExport`'s documented default).
   */
  targetCampaignId?: Id;
  /** The success toast's sentence — the caller owns its wording. */
  describeSuccess: (result: ImportResult) => string;
  /** Runs after a successful import (the picker navigates to the new campaign). */
  onImported?: (result: ImportResult) => void;
}

export interface CampaignImport {
  /** Reads the picked file and starts the flow (parse → deps → import). */
  handleFile: (file: File) => Promise<void>;
  /** The dependency dialog, composed once so both hosts render the same gate. */
  dialog: JSX.Element;
}

export function useCampaignImport(request: CampaignImportRequest): CampaignImport {
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [working, setWorking] = useState(false);

  async function attemptImport(
    payload: PendingImportPayload,
    policy: DependencyPolicy,
  ): Promise<void> {
    const options: ImportOptions = {
      dependencyPolicy: policy,
      ...(request.targetCampaignId === undefined
        ? {}
        : { targetCampaignId: request.targetCampaignId }),
    };
    const result =
      payload.kind === 'zip'
        ? await importZip(payload.bytes, options)
        : await importExport(payload.raw, {}, options);
    toastSuccess(request.describeSuccess(result));
    // Version drift (docs/17 row 261): the import PROCEEDED over citations that
    // resolved to the same book under a DIFFERENT version. It is not an abort
    // any more, so the count must ride the success — an unblocked fallback
    // that said nothing would be the silent failure AGENTS rule 1 forbids.
    const driftNote = formatDriftedCitations(result.driftedCitations);
    if (driftNote !== null) toastInfo(driftNote);
    request.onImported?.(result);
  }

  async function handleFile(file: File): Promise<void> {
    let payload: PendingImportPayload;
    try {
      // Zip bundles carry image binaries next to the manifest (M3-A).
      const isZip = file.name.endsWith('.zip') || file.type === 'application/zip';
      payload = isZip
        ? { kind: 'zip', bytes: new Uint8Array(await file.arrayBuffer()) }
        : { kind: 'json', raw: JSON.parse(await file.text()) as unknown };
    } catch (error) {
      // Every import-failure toast carries MITIGATION, not just cause:
      // Zod-shaped failures ride through untouched (the toast seam
      // humanizes them and appends the version-skew mitigation); anything
      // else gets the mitigation appended by `withImportMitigation`.
      toastError('Import failed — is this a Campaigner export?', withImportMitigation(error));
      return;
    }
    let analysis: DependencyAnalysis;
    try {
      // The strict boundary: a pre-cut file is REFUSED by name here, before the
      // dependency dialog or any write (docs/17 row 278).
      const manifest =
        payload.kind === 'zip'
          ? parseExport(parseZipExport(payload.bytes).manifest).dependencies
          : parseExport(payload.raw).dependencies;
      analysis = await checkImportDependencies(manifest);
    } catch (error) {
      toastError('Import failed — is this a Campaigner export?', withImportMitigation(error));
      return;
    }
    if (!analysis.clean) {
      // Abort-by-default: the dialog, not a toast — nothing imported yet.
      setPending({ analysis, payload });
      return;
    }
    try {
      await attemptImport(payload, 'abort');
    } catch (error) {
      if (error instanceof MissingDependenciesError) {
        // The library changed between analysis and import — same dialog.
        setPending({ analysis: error.analysis, payload });
        return;
      }
      toastError('Import failed — is this a Campaigner export?', withImportMitigation(error));
    }
  }

  async function importAnyway(): Promise<void> {
    const current = pending;
    if (current === null || working) return;
    setWorking(true);
    try {
      await attemptImport(current.payload, 'import-anyway');
      setPending(null);
    } catch (error) {
      toastError('Import failed — is this a Campaigner export?', withImportMitigation(error));
    } finally {
      setWorking(false);
    }
  }

  const dialog = (
    <ImportDepsDialog
      pending={pending}
      working={working}
      onAbort={() => {
        setPending(null);
      }}
      onImportAnyway={() => {
        void importAnyway();
      }}
    />
  );
  return { handleFile, dialog };
}
