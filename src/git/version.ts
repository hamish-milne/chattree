export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Parse the output of `git version` ("git version 2.43.0", "git version 2.39.3 (Apple Git-146)", "git version 2.43.0.windows.1"). */
export function parseGitVersion(text: string): GitVersion | undefined {
  const m = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text.trim());
  if (m === null) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

export function compareVersions(a: GitVersion, b: GitVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export const formatVersion = (v: GitVersion): string => `${v.major}.${v.minor}.${v.patch}`;

/** See docs/git-integration.md, D7. */
export const MIN_GIT_VERSION: GitVersion = { major: 2, minor: 40, patch: 0 };
