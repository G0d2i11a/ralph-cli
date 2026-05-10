import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ToolchainEnvFingerprint {
  corepackHome?: string;
  pnpmHome?: string;
  xdgCacheHome?: string;
  prismaEnginesCacheDir?: string;
  packageManagerSpec?: string;
}

function readPackageManagerSpec(installRoot?: string): string | undefined {
  if (!installRoot) {
    return undefined;
  }

  const manifestPath = path.join(installRoot, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    return undefined;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { packageManager?: unknown };
    return typeof manifest.packageManager === 'string' ? manifest.packageManager : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCorepackHome(
  baseEnv: NodeJS.ProcessEnv = process.env,
  ralphHome?: string,
): string | undefined {
  if (baseEnv.COREPACK_HOME && fs.existsSync(baseEnv.COREPACK_HOME)) {
    return baseEnv.COREPACK_HOME;
  }

  if (process.env.COREPACK_HOME && fs.existsSync(process.env.COREPACK_HOME)) {
    return process.env.COREPACK_HOME;
  }

  const userCache = path.join(os.homedir(), '.cache', 'node', 'corepack');
  if (fs.existsSync(userCache)) {
    return userCache;
  }

  if (ralphHome) {
    const ralphCache = path.join(ralphHome, 'tool-cache', 'corepack');
    fs.mkdirSync(ralphCache, { recursive: true });
    return ralphCache;
  }

  return undefined;
}

export function isCorepackDownloadFailure(text: string | undefined): boolean {
  if (!text) {
    return false;
  }

  return /Corepack is about to download/i.test(text)
    || /corepack[\s\S]{0,200}(fetch failed|performing the request|Connect Timeout|ETIMEDOUT|ENOTFOUND)/i.test(text)
    || /pnpm-\d+\.\d+\.\d+\.tgz/i.test(text);
}

export function buildRalphToolchainEnv(input: {
  baseEnv?: NodeJS.ProcessEnv;
  installRoot?: string;
  ralphHome?: string;
  sandboxHome?: string;
} = {}): { env: NodeJS.ProcessEnv; fingerprint: ToolchainEnvFingerprint } {
  const baseEnv = input.baseEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    CI: baseEnv.CI ?? '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    PRISMA_HIDE_UPDATE_MESSAGE: 'true',
  };

  const ralphHome = input.ralphHome ?? baseEnv.RALPH_HOME ?? process.env.RALPH_HOME;
  const corepackHome = resolveCorepackHome(baseEnv, ralphHome);
  if (corepackHome) {
    env.COREPACK_HOME = corepackHome;
  }

  if (baseEnv.PNPM_HOME) {
    env.PNPM_HOME = baseEnv.PNPM_HOME;
  }

  if (!env.PRISMA_ENGINES_CACHE_DIR) {
    env.PRISMA_ENGINES_CACHE_DIR = ralphHome
      ? path.join(ralphHome, 'tool-cache', 'prisma')
      : path.join(input.sandboxHome ?? os.tmpdir(), '.cache', 'prisma');
  }

  return {
    env,
    fingerprint: {
      corepackHome: env.COREPACK_HOME,
      pnpmHome: env.PNPM_HOME,
      xdgCacheHome: env.XDG_CACHE_HOME,
      prismaEnginesCacheDir: env.PRISMA_ENGINES_CACHE_DIR,
      packageManagerSpec: readPackageManagerSpec(input.installRoot),
    },
  };
}
