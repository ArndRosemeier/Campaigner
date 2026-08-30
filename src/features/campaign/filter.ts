import type { Artifact } from '@/domain';

/**
 * Tree filter (05-UI §Workspace): case-insensitive substring match on the
 * artifact name or any of its tags.
 */
export function matchesFilter(artifact: Artifact, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return true;
  return (
    artifact.name.toLowerCase().includes(needle) ||
    artifact.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
}
