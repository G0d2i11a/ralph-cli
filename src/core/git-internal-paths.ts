const RESERVED_GIT_INTERNAL_ROOTS = [
  '.git',
  '.git-local',
  '.git-local-admin',
  '.git-local-objects',
  '.ralph-integration-probe',
];

function normalizeRelativePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

export function isGitInternalPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return false;
  }

  return RESERVED_GIT_INTERNAL_ROOTS.some((root) => (
    normalized === root || normalized.startsWith(`${root}/`)
  ));
}

export function filterGitInternalPaths(paths: string[]): string[] {
  return paths
    .map((entry) => normalizeRelativePath(entry))
    .filter(Boolean)
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .filter((entry) => !isGitInternalPath(entry));
}

export function buildGitInternalExcludePathspecs(): string[] {
  return RESERVED_GIT_INTERNAL_ROOTS.flatMap((root) => ([
    `:(top,exclude)${root}`,
    `:(top,exclude)${root}/**`,
  ]));
}
