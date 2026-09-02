import { useState } from 'react';
import { PlusIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AnyArtifact, ArtifactLink, Id } from '@/domain';

export interface LinksSectionProps {
  links: readonly ArtifactLink[];
  onChange: (links: ArtifactLink[]) => void;
  /** All artifacts of the campaign (candidates + name lookup); self excluded from candidates. */
  campaignArtifacts: readonly AnyArtifact[];
  selfId: Id;
}

const DEFAULT_RELATION = 'related-to';

/**
 * Links editor (05-UI): list of `relation → target name` rows; the target is
 * a combobox over the campaign's artifacts. Links referencing deleted
 * artifacts render as such instead of breaking.
 */
export function LinksSection({ links, onChange, campaignArtifacts, selfId }: LinksSectionProps) {
  const [newRelation, setNewRelation] = useState('');
  const [newTargetId, setNewTargetId] = useState<string>('');

  const nameOf = (targetId: string): string =>
    campaignArtifacts.find((artifact) => artifact.id === targetId)?.name ?? '(deleted artifact)';
  const candidates = campaignArtifacts.filter((artifact) => artifact.id !== selfId);

  function addLink(): void {
    if (newTargetId === '') return;
    onChange([
      ...links,
      { targetId: newTargetId, relation: newRelation.trim() || DEFAULT_RELATION },
    ]);
    setNewRelation('');
    setNewTargetId('');
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Links</h2>
      {links.map((link, index) => (
        <div key={`${link.targetId}-${index}`} className="flex items-center gap-1">
          <Input
            value={link.relation}
            aria-label={`Relation of link ${index + 1}`}
            placeholder="Relation"
            className="h-7 w-40 shrink-0 text-sm"
            onChange={(event) => {
              onChange(
                links.map((existing, i) =>
                  i === index ? { ...existing, relation: event.target.value } : existing,
                ),
              );
            }}
          />
          <span className="text-xs text-muted-foreground">→</span>
          <span className="flex-1 truncate text-sm">{nameOf(link.targetId)}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove link ${index + 1}`}
            onClick={() => {
              onChange(links.filter((_, i) => i !== index));
            }}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ))}

      <div className="flex items-center gap-1">
        <Input
          value={newRelation}
          placeholder={`Relation (default: ${DEFAULT_RELATION})`}
          aria-label="New link relation"
          className="h-7 w-40 shrink-0 text-sm"
          onChange={(event) => {
            setNewRelation(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addLink();
            }
          }}
        />
        <span className="text-xs text-muted-foreground">→</span>
        <Select
          value={newTargetId === '' ? null : newTargetId}
          items={Object.fromEntries(candidates.map((artifact) => [artifact.id, artifact.name]))}
          onValueChange={(value) => {
            setNewTargetId(value ?? '');
          }}
        >
          <SelectTrigger size="sm" className="w-44" aria-label="New link target">
            <SelectValue placeholder="Choose artifact…" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((artifact) => (
              <SelectItem key={artifact.id} value={artifact.id}>
                {artifact.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="icon-xs"
          variant="outline"
          aria-label="Add link"
          disabled={newTargetId === ''}
          onClick={addLink}
        >
          <PlusIcon aria-hidden />
        </Button>
      </div>
      {candidates.length === 0 && (
        <p className="text-xs text-muted-foreground">Create another artifact to link to it.</p>
      )}
    </section>
  );
}
