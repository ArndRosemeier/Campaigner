import type { BattleTokenId } from '@/domain';

/**
 * One-step reorder: the SAME splice-and-commit path the old drop handler
 * used (remove at `from`, insert at the clamped neighbor). Returns the new
 * order, or null when the token is not in the order (no commit then).
 */
export function moveInitiativeOrder(
  order: BattleTokenId[],
  tokenId: BattleTokenId,
  delta: -1 | 1,
): BattleTokenId[] | null {
  const from = order.indexOf(tokenId);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(order.length - 1, from + delta));
  if (to === from) return null;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, tokenId);
  return next;
}
