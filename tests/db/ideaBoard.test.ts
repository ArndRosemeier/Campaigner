import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { db } from '@/db/db';
import { getIdeaBoard, saveIdeaBoard } from '@/db/ideaBoardRepo';
import { newIdeaBoard } from '@/domain/ideaBoard';
import { buildBackup, importBackup } from '@/lib/backup';
import { clearDatabase } from './helpers';

beforeEach(clearDatabase);
it('creates exactly one board across concurrent opens and refuses conflicting saves', async () => {
  const [a, b] = await Promise.all([getIdeaBoard(), getIdeaBoard()]);
  expect(a).toEqual(b);
  expect(await db.ideaBoards.count()).toBe(1);
  const saved = await saveIdeaBoard({ ...a, document: '[[literal]]' }, a);
  await expect(saveIdeaBoard({ ...b, document: 'stale' }, b)).rejects.toThrow('another tab');
  expect(await getIdeaBoard()).toEqual(saved);
});
it('refuses multiple boards rather than selecting or discarding one', async () => {
  await db.ideaBoards.bulkAdd([newIdeaBoard(), newIdeaBoard()]);
  await expect(getIdeaBoard()).rejects.toThrow('multiple boards');
});
it('validates writes and preserves stored text on failure', async () => {
  const board = await getIdeaBoard();
  await expect(saveIdeaBoard({ ...board, document: 42 } as never, board)).rejects.toThrow();
  expect(await getIdeaBoard()).toEqual(board);
});
it('backs up the global document and rejects corrupt restores before wiping', async () => {
  const board = await getIdeaBoard();
  await saveIdeaBoard({ ...board, document: 'Travel plans — [[plain text]]' }, board);
  const backup = await buildBackup();
  await clearDatabase();
  await importBackup(backup.bytes);
  expect((await getIdeaBoard()).document).toContain('Travel plans');
  const files = unzipSync(backup.bytes);
  const raw = files['campaigner-backup.json'];
  if (raw === undefined) throw new Error('missing manifest');
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as { data: Record<string, unknown[]> };
  manifest.data.ideaBoards = [{ ...board, document: 99 }];
  files['campaigner-backup.json'] = strToU8(JSON.stringify(manifest));
  await expect(importBackup(zipSync(files))).rejects.toThrow();
  expect((await getIdeaBoard()).document).toContain('Travel plans');});
