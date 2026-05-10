const OPERATIONAL_ARTIFACT_DIRS = [
  'node_modules',
  '.turbo',
  '.ralph',
  '.ralph-cli-home',
  '.ralph-worktrees',
  '.ralph-integration',
  '.ralph-integration-probe',
];
const OPERATIONAL_ARTIFACT_DIR_PREFIXES = [
  '.next.stale-build',
];

function normalizeRelativePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

export function isOperationalArtifactPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return false;
  }

  return normalized
    .split('/')
    .some((segment) => (
      OPERATIONAL_ARTIFACT_DIRS.includes(segment)
      || OPERATIONAL_ARTIFACT_DIR_PREFIXES.some((prefix) => segment.startsWith(prefix))
    ));
}

export function filterOperationalArtifactPaths(paths: string[]): string[] {
  return paths
    .map((entry) => normalizeRelativePath(entry))
    .filter(Boolean)
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .filter((entry) => !isOperationalArtifactPath(entry));
}

export function buildOperationalArtifactExcludePathspecs(): string[] {
  return [
    ...OPERATIONAL_ARTIFACT_DIRS.flatMap((dir) => ([
      `:(glob,exclude)**/${dir}`,
      `:(glob,exclude)**/${dir}/**`,
    ])),
    ...OPERATIONAL_ARTIFACT_DIR_PREFIXES.flatMap((prefix) => ([
      `:(glob,exclude)**/${prefix}*`,
      `:(glob,exclude)**/${prefix}*/**`,
    ])),
  ];
}
