import * as fs from 'fs';
import * as path from 'path';
import { isGitInternalPath } from './git-internal-paths';
import { isOperationalArtifactPath } from './operational-artifacts';

function normalizeRelativePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function hasGlobSyntax(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function resolveDeclaredPath(worktreePath: string, value: string): string | undefined {
  const raw = value.trim();
  if (!raw) {
    return undefined;
  }

  const worktreeRoot = path.resolve(worktreePath);
  const relativePath = path.isAbsolute(raw)
    ? path.relative(worktreeRoot, path.resolve(raw))
    : raw;
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.startsWith('../') || normalized === '..' || path.isAbsolute(normalized)) {
    return undefined;
  }

  if (hasGlobSyntax(normalized) || isGitInternalPath(normalized) || isOperationalArtifactPath(normalized)) {
    return undefined;
  }

  const absolutePath = path.resolve(worktreeRoot, normalized);
  if (absolutePath !== worktreeRoot && !absolutePath.startsWith(`${worktreeRoot}${path.sep}`)) {
    return undefined;
  }

  return normalized;
}

export function listExistingDeclaredWriteSurfaceFiles(
  worktreePath: string,
  declaredWriteSurface?: string[],
): string[] {
  if (!Array.isArray(declaredWriteSurface) || declaredWriteSurface.length === 0) {
    return [];
  }

  const worktreeRoot = path.resolve(worktreePath);
  const files: string[] = [];
  for (const entry of declaredWriteSurface) {
    if (typeof entry !== 'string') {
      continue;
    }

    const relativePath = resolveDeclaredPath(worktreeRoot, entry);
    if (!relativePath) {
      continue;
    }

    const absolutePath = path.join(worktreeRoot, relativePath);
    try {
      if (fs.statSync(absolutePath).isFile()) {
        files.push(relativePath);
      }
    } catch {
      // Missing declared outputs are handled by task validation, not staging.
    }
  }

  return [...new Set(files)].sort();
}
