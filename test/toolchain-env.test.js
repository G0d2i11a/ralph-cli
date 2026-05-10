const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildRalphToolchainEnv,
  isCorepackDownloadFailure,
  resolveCorepackHome,
} = require('../dist/core/toolchain-env.js');

test('toolchain env preserves explicit COREPACK_HOME while HOME is sandboxed', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-toolchain-env-'));
  const corepackHome = path.join(tempDir, 'corepack');
  const sandboxHome = path.join(tempDir, 'sandbox-home');
  const installRoot = path.join(tempDir, 'repo');

  try {
    fs.mkdirSync(corepackHome, { recursive: true });
    fs.mkdirSync(sandboxHome, { recursive: true });
    fs.mkdirSync(installRoot, { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'package.json'), '{"packageManager":"pnpm@9.0.0"}\n');

    const { env, fingerprint } = buildRalphToolchainEnv({
      baseEnv: {
        ...process.env,
        HOME: sandboxHome,
        COREPACK_HOME: corepackHome,
      },
      installRoot,
      sandboxHome,
    });

    assert.equal(resolveCorepackHome(env), corepackHome);
    assert.equal(env.COREPACK_HOME, corepackHome);
    assert.equal(env.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0');
    assert.equal(env.CI, '1');
    assert.equal(fingerprint.corepackHome, corepackHome);
    assert.equal(fingerprint.packageManagerSpec, 'pnpm@9.0.0');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('toolchain env falls back to Ralph corepack cache when user cache is unavailable', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-toolchain-env-'));
  const ralphHome = path.join(tempDir, 'ralph-home');
  const originalHome = process.env.HOME;
  const originalCorepackHome = process.env.COREPACK_HOME;

  try {
    process.env.HOME = path.join(tempDir, 'home-without-corepack');
    delete process.env.COREPACK_HOME;
    const { env } = buildRalphToolchainEnv({
      baseEnv: {
        ...process.env,
        COREPACK_HOME: undefined,
      },
      ralphHome,
    });

    assert.equal(env.COREPACK_HOME, path.join(ralphHome, 'tool-cache', 'corepack'));
    assert.equal(fs.existsSync(env.COREPACK_HOME), true);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalCorepackHome === undefined) {
      delete process.env.COREPACK_HOME;
    } else {
      process.env.COREPACK_HOME = originalCorepackHome;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('detects Corepack download and pnpm tarball failures', () => {
  assert.equal(isCorepackDownloadFailure('Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-9.0.0.tgz'), true);
  assert.equal(isCorepackDownloadFailure('corepack failed: fetch failed Connect Timeout'), true);
  assert.equal(isCorepackDownloadFailure('ordinary test assertion failed'), false);
});
