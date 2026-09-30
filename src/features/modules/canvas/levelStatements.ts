import { withEntityLevelStatement } from '@/domain/module';
import { updateModuleEntityKinds } from '@/db/moduleRepo';
import { isLevelStatementCommand, type CanvasEditCommand } from '@/llm/canvasChat';
import { appliedOutcome, failedOutcome } from '@/features/modules/canvas/chatApply';
import type { CanvasChatOutcome } from '@/features/modules/canvas/chatStore';

/**
 * THE LEVEL STATEMENTS of one reply (docs/17 row 401): the story author STATES
 * an NPC's or encounter's level and this is where the statement becomes DATA —
 * the entity RECORD's `levelHint`, written through the ONE record writer
 * (`domain/module.withEntityLevelStatement`) inside the ONE atomic record update
 * (`db/moduleRepo.updateModuleEntityKinds`). The document text is never touched.
 *
 * Per-command and loud (the row-381 semantics): a refused statement (level out
 * of 1..20, a non-integer, an unknown name with no stated kind, a kind that has
 * no level) becomes a FAILED outcome card carrying the writer's reason, and its
 * siblings still apply. Nothing is dropped silently.
 */
export async function applyLevelStatements(
  moduleId: string,
  commands: readonly CanvasEditCommand[],
): Promise<CanvasChatOutcome[]> {
  const statements = commands.filter(isLevelStatementCommand);
  if (statements.length === 0) return [];
  const outcomes: CanvasChatOutcome[] = [];
  await updateModuleEntityKinds(moduleId, (current) => {
    let records = [...current];
    let changed = false;
    for (const statement of statements) {
      const result = withEntityLevelStatement(
        records,
        statement.name,
        statement.level,
        statement.entityKind,
      );
      if (!result.ok) {
        outcomes.push(failedOutcome(statement, result.reason));
        continue;
      }
      records = result.records;
      changed = true;
      outcomes.push(appliedOutcome(statement, { planIndex: -1, title: statement.name }, 1, null, null, null));
    }
    return changed ? records : null;
  });
  return outcomes;
}
