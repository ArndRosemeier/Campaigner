import { db } from '@/db/db';
import { ideaBoardSchema, newIdeaBoard, parseIdeaBoards, type IdeaBoard } from '@/domain/ideaBoard';

export async function getIdeaBoard(): Promise<IdeaBoard> {
  return db.transaction('rw', db.ideaBoards, async () => {
    const [existing] = parseIdeaBoards(await db.ideaBoards.toArray());
    if (existing !== undefined) return existing;
    const board = newIdeaBoard();
    await db.ideaBoards.add(board);
    return board;
  });
}
/** Compare the full saved snapshot inside the transaction; another tab must never be overwritten. */
export async function saveIdeaBoard(next: IdeaBoard, expected: IdeaBoard): Promise<IdeaBoard> {
  const parsed = ideaBoardSchema.parse(next);
  return db.transaction('rw', db.ideaBoards, async () => {
    const [current] = parseIdeaBoards(await db.ideaBoards.toArray());
    if (current === undefined || JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error('Idea Board changed in another tab or was restored. Copy your draft before reloading.');
    }
    const saved = ideaBoardSchema.parse({ ...parsed, id: current.id, createdAt: current.createdAt, updatedAt: Date.now() });
    await db.ideaBoards.put(saved);
    return saved;
  });
}
