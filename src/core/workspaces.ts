import * as fs from 'fs';
import * as path from 'path';

export interface WorkspaceManifest {
  workspaces?: string[] | { packages?: string[] };
}

function stripSurroundingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith('\'') && value.endsWith('\''))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseManifestWorkspacePatterns(manifest: WorkspaceManifest | null): string[] {
  const workspaces = manifest?.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces;
  }

  if (workspaces && Array.isArray(workspaces.packages)) {
    return workspaces.packages;
  }

  return [];
}

function parsePnpmWorkspacePatterns(content: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  let packagesIndent = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '  ');
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const packagesMatch = line.match(/^(\s*)packages\s*:\s*$/);
    if (packagesMatch) {
      inPackages = true;
      packagesIndent = packagesMatch[1].length;
      continue;
    }

    if (!inPackages) {
      continue;
    }

    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= packagesIndent && /^[A-Za-z0-9_-]+\s*:/.test(trimmed)) {
      break;
    }

    const itemMatch = line.match(/^\s*-\s*(.+?)\s*$/);
    if (!itemMatch) {
      continue;
    }

    const item = stripSurroundingQuotes(itemMatch[1].trim()).trim();
    if (item) {
      patterns.push(item);
    }
  }

  return patterns;
}

function readPnpmWorkspacePatterns(rootPath: string): string[] {
  for (const filename of ['pnpm-workspace.yaml', 'pnpm-workspace.yml']) {
    const workspacePath = path.join(rootPath, filename);
    if (!fs.existsSync(workspacePath)) {
      continue;
    }

    try {
      return parsePnpmWorkspacePatterns(fs.readFileSync(workspacePath, 'utf-8'));
    } catch {
      return [];
    }
  }

  return [];
}

function expandSimpleWorkspacePattern(rootPath: string, pattern: string): string[] {
  if (!pattern.endsWith('/*') || pattern.includes('**')) {
    return [];
  }

  const parent = path.join(rootPath, pattern.slice(0, -2));
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parent, entry.name))
      .filter((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
  } catch {
    return [];
  }
}

export function getWorkspacePatterns(rootPath: string, manifest: WorkspaceManifest | null): string[] {
  const manifestPatterns = parseManifestWorkspacePatterns(manifest);
  if (manifestPatterns.length > 0) {
    return manifestPatterns;
  }

  return readPnpmWorkspacePatterns(rootPath);
}

export function resolveWorkspacePackageDirs(rootPath: string, manifest: WorkspaceManifest | null): string[] {
  const dirs = new Set<string>();

  for (const pattern of getWorkspacePatterns(rootPath, manifest)) {
    for (const workspaceDir of expandSimpleWorkspacePattern(rootPath, pattern)) {
      dirs.add(path.resolve(workspaceDir));
    }
  }

  return [...dirs];
}
