/**
 * THE environment for a git command a test runs against a THROWAWAY repository
 * (docs/17 row 428): the caller's environment with every `GIT_*` variable
 * removed.
 *
 * Why, measured: inside a git hook (the pre-push tier runs the architecture
 * pins) `GIT_DIR` points at the REAL repository, and a child `git init` /
 * `git commit` inherits it — the fixtures were committed onto the pushing
 * branch and `core.bare=true` plus a `[user]` section landed in the real
 * `.git/config`. `cwd` alone does not isolate a git command; this does.
 */
export function isolatedGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return { ...env, ...extra };
}
