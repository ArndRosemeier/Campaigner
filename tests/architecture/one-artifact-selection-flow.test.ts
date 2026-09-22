import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE one artifact-selection flow (docs/17 row 322; AGENTS rule 4). The
 * workspace's multi-select is a NEW surface over machinery that already
 * existed, and the risk it carries is exactly the one the centralization rule
 * names: a second export build+save sequence, a second import file flow or a
 * second removal census would answer identically today and drift the day one
 * side changes. So each idea is ONE seam, and this SOURCE SCAN holds the call
 * sites to that:
 *
 * - `exportCampaignBundle` (the acquire-target → build → write → toast
 *   sequence) is called by BOTH hosts — the picker's `ExportCampaignDialog` and
 *   the workspace's selection bar — and by nobody else. Neither host may reach
 *   `buildCampaignExport` directly for a campaign export.
 * - `useCampaignImport` (read file → `parseExport` → `checkImportDependencies`
 *   → the ONE `ImportDepsDialog` → `importZip`/`importExport`) is called by the
 *   picker and the workspace, and nobody may call `importZip`/`importExport`
 *   outside it.
 * - the removal census and pass (`describeArtifactSelectionRemoval` /
 *   `deleteArtifactSelection`, and their kind twins) have exactly ONE caller:
 *   the shared `RemoveArtifactsDialog`.
 *
 * The bodies themselves are held by the general duplication tripwire
 * (`no-duplicate-implementations`); this pin holds the ROUTING. The source
 * walk and the comment strip are INLINE here on purpose: a named
 * `sourceFiles`/`stripComments` helper pair is already baselined as duplicated
 * test-tree debt, and a thirteenth copy would inflate that inventory instead
 * of holding the routing rule this file exists for.
 */

const SOURCES = readdirSync(join(process.cwd(), 'src'), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
  .map((entry) => ({
    rel: relative(process.cwd(), join(entry.parentPath, entry.name)),
    code: readFileSync(join(entry.parentPath, entry.name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, ''),
  }))
  .sort((left, right) => left.rel.localeCompare(right.rel));

/** Every `src/` file that CALLS `name(`, as repo-relative paths (the file that
 * DEFINES the seam is excluded by the caller's list — its declaration is not a
 * call site). */
function callSites(name: string, exclude: readonly string[]): string[] {
  const pattern = new RegExp(`\\b${name}\\s*\\(`);
  return SOURCES.filter(
    (source) => !exclude.includes(source.rel) && pattern.test(source.code),
  ).map((source) => source.rel);
}

interface Seam {
  readonly name: string;
  /** The file that DEFINES the seam (its declaration is not a call site). */
  readonly definition: string;
  readonly hosts: readonly string[];
}

/** The lower-level seams: ONE host each (the upper seam that calls them). */
const RAW_SEAMS: readonly Seam[] = [
  {
    name: 'buildCampaignExport',
    definition: 'src/lib/exportImport.ts',
    hosts: ['src/features/campaign/components/export-campaign-bundle.ts'],
  },
  {
    name: 'importZip',
    definition: 'src/lib/exportImport.ts',
    hosts: ['src/features/campaign/import-flow.tsx'],
  },
  {
    name: 'importExport',
    definition: 'src/lib/exportImport.ts',
    hosts: ['src/features/campaign/import-flow.tsx'],
  },
  {
    name: 'deleteArtifactsOfKind',
    definition: 'src/db/artifactRepo.ts',
    hosts: ['src/features/campaign/components/remove-artifacts-dialog.tsx'],
  },
  {
    name: 'deleteArtifactSelection',
    definition: 'src/db/artifactRepo.ts',
    hosts: ['src/features/campaign/components/remove-artifacts-dialog.tsx'],
  },
  {
    name: 'describeArtifactKindRemoval',
    definition: 'src/db/artifactRepo.ts',
    hosts: ['src/features/campaign/components/remove-artifacts-dialog.tsx'],
  },
  {
    name: 'describeArtifactSelectionRemoval',
    definition: 'src/db/artifactRepo.ts',
    hosts: ['src/features/campaign/components/remove-artifacts-dialog.tsx'],
  },
];

/** The two surface seams: EXACTLY the two named hosts, never a third. */
const SURFACE_SEAMS: readonly Seam[] = [
  {
    name: 'exportCampaignBundle',
    definition: 'src/features/campaign/components/export-campaign-bundle.ts',
    hosts: [
      'src/features/campaign/components/export-dialog.tsx',
      'src/features/campaign/components/campaign-tree.tsx',
    ],
  },
  {
    name: 'useCampaignImport',
    definition: 'src/features/campaign/import-flow.tsx',
    hosts: [
      'src/features/campaign/CampaignPickerPage.tsx',
      'src/features/campaign/components/campaign-tree.tsx',
    ],
  },
];

describe('one artifact-selection flow (SOURCE SCAN, docs/17 row 322)', () => {
  it.each(RAW_SEAMS.map((seam) => [seam.name, seam] as const))(
    'routes `%s` through exactly its ONE seam host',
    (_name, seam) => {
      expect(callSites(seam.name, [seam.definition])).toEqual([...seam.hosts]);
    },
  );

  it.each(SURFACE_SEAMS.map((seam) => [seam.name, seam] as const))(
    'routes `%s` through EXACTLY its two declared hosts',
    (_name, seam) => {
      expect(callSites(seam.name, [seam.definition]).sort()).toEqual([...seam.hosts].sort());
    },
  );

  it('does not let a host reach the raw export/import seams it must not', () => {
    // Non-vacuity of the routing rule: the hosts call the SURFACE seam, so the
    // raw ones are reachable from exactly one file each (never from the dialog
    // or the picker directly).
    for (const seam of RAW_SEAMS) {
      const sites = callSites(seam.name, [seam.definition]);
      expect(new Set(sites).size).toBe(sites.length);
      expect(sites).toHaveLength(1);
    }
  });
});
