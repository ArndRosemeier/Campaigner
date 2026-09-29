// Types for scripts/publish.mjs (a plain .mjs so the owner can run it with bare node).
export interface RunResult {
  status: number;
  stdout: string;
}
export type Runner = (
  command: string,
  args: string[],
  options?: { capture?: boolean; env?: Record<string, string> },
) => RunResult;
export interface PublishOptions {
  root: string;
  run: Runner;
  fetchText: (url: string) => Promise<string>;
  dryRun?: boolean;
  target?: string;
  liveUrl?: string;
  log?: (line: string) => void;
  readFile?: (path: string) => string;
  writeFile?: (path: string, text: string) => void;
  makeTempDir?: () => string;
}
export interface PublishResult {
  ok: boolean;
  version: string | null;
  error?: string;
  outDir?: string;
}
export const LIVE_TARGET: string;
export const LIVE_URL: string;
export function entryAsset(html: string): string;
export function publish(options: PublishOptions): Promise<PublishResult>;
