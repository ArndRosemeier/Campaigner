import { deliverableSchema, stampNewEntity, type Deliverable, type Id, type NewDeliverable } from '@/domain';
import { db } from '@/db/db';

/**
 * Deliverable persistence (07-MILESTONE-3 M3-D): module PDF outlines live in
 * their own table and are only ever written through the outline editor.
 */

export async function createDeliverable(input: NewDeliverable): Promise<Deliverable> {
  const deliverable = deliverableSchema.parse({ ...stampNewEntity(), ...input });
  await db.deliverables.put(deliverable);
  return deliverable;
}

export async function getDeliverable(id: Id): Promise<Deliverable | undefined> {
  const row = await db.deliverables.get(id);
  return row === undefined ? undefined : deliverableSchema.parse(row);
}

export async function listDeliverablesByCampaign(campaignId: Id): Promise<Deliverable[]> {
  const rows = await db.deliverables.where('campaignId').equals(campaignId).toArray();
  return rows
    .map((row) => deliverableSchema.parse(row))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function updateDeliverable(
  id: Id,
  patch: Partial<Omit<Deliverable, 'id' | 'createdAt'>>,
): Promise<Deliverable> {
  const current = await db.deliverables.get(id);
  if (current === undefined) throw new Error(`Deliverable ${id} not found`);
  const merged = deliverableSchema.parse({
    ...current,
    ...patch,
    updatedAt: Date.now(),
  });
  await db.deliverables.put(merged);
  return merged;
}

export async function deleteDeliverable(id: Id): Promise<void> {
  await db.deliverables.delete(id);
}
