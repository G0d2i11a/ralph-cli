const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  bootstrapWorktreeDeps,
  detectPackageManager,
  needsBootstrap,
} = require('../dist/core/bootstrap.js');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bootstrap-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeFile(filePath, value = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

test('detectPackageManager prioritizes pnpm across repo and worktree signals', (t) => {
  const worktreePath = makeTempDir(t);
  const repoPath = makeTempDir(t);

  writeJson(path.join(worktreePath, 'package.json'), {
    devDependencies: {
      jest: '^29.0.0',
    },
  });
  writeFile(path.join(worktreePath, 'package-lock.json'));
  writeFile(path.join(repoPath, 'pnpm-lock.yaml'));

  assert.equal(detectPackageManager(worktreePath, repoPath), 'pnpm');
});

test('bootstrapWorktreeDeps installs pnpm from the worktree root', (t) => {
  const worktreePath = makeTempDir(t);
  const repoPath = makeTempDir(t);
  const calls = [];

  writeJson(path.join(worktreePath, 'package.json'), {
    private: true,
    workspaces: ['packages/*'],
    devDependencies: {
      jest: '^29.0.0',
    },
  });
  writeFile(path.join(worktreePath, 'pnpm-lock.yaml'));
  writeFile(path.join(worktreePath, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');

  writeJson(path.join(repoPath, 'package.json'), {
    private: true,
    workspaces: ['packages/*'],
  });
  writeFile(path.join(repoPath, 'pnpm-lock.yaml'));
  fs.mkdirSync(path.join(repoPath, 'node_modules', '.pnpm'), { recursive: true });

  const result = bootstrapWorktreeDeps(worktreePath, {
    repoPath,
    logger: () => {},
    commandRunner: (command, args, cwd) => {
      calls.push({ command, args, cwd });
      fs.mkdirSync(path.join(worktreePath, 'node_modules', '.pnpm'), { recursive: true });
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.bootstrapped, true);
  assert.equal(result.packageManager, 'pnpm');
  assert.equal(result.installRoot, worktreePath);
  assert.deepEqual(calls, [
    {
      command: 'pnpm',
      args: ['install', '--frozen-lockfile'],
      cwd: worktreePath,
    },
  ]);
});

test('bootstrapWorktreeDeps skips repositories without package.json', (t) => {
  const worktreePath = makeTempDir(t);
  let commandRan = false;

  const result = bootstrapWorktreeDeps(worktreePath, {
    logger: () => {},
    commandRunner: () => {
      commandRan = true;
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.bootstrapped, false);
  assert.equal(commandRan, false);
});

test('needsBootstrap returns false when pnpm artifacts already exist', (t) => {
  const worktreePath = makeTempDir(t);

  writeJson(path.join(worktreePath, 'package.json'), {
    devDependencies: {
      typescript: '^5.0.0',
    },
  });
  writeFile(path.join(worktreePath, 'pnpm-lock.yaml'));
  fs.mkdirSync(path.join(worktreePath, 'node_modules', '.pnpm'), { recursive: true });

  assert.equal(needsBootstrap(worktreePath), false);
});

test('needsBootstrap treats yarn pnp installs as bootstrapped', (t) => {
  const worktreePath = makeTempDir(t);

  writeJson(path.join(worktreePath, 'package.json'), {
    packageManager: 'yarn@4.6.0',
    devDependencies: {
      typescript: '^5.0.0',
    },
  });
  writeFile(path.join(worktreePath, 'yarn.lock'));
  writeFile(path.join(worktreePath, '.pnp.cjs'));

  assert.equal(needsBootstrap(worktreePath), false);
});

test('bootstrapWorktreeDeps reuses workspace-level node_modules from repo artifacts', (t) => {
  const worktreePath = makeTempDir(t);
  const repoPath = makeTempDir(t);
  const manifest = {
    private: true,
    workspaces: ['apps/*'],
  };

  writeJson(path.join(repoPath, 'package.json'), manifest);
  writeFile(path.join(repoPath, 'package-lock.json'));
  fs.mkdirSync(path.join(repoPath, 'node_modules', '.bin'), { recursive: true });
  fs.mkdirSync(path.join(repoPath, 'apps', 'web', 'node_modules', '.bin'), { recursive: true });
  writeJson(path.join(repoPath, 'apps', 'web', 'package.json'), {
    scripts: { build: 'vite build' },
    dependencies: { vite: '^6.0.0' },
  });

  writeJson(path.join(worktreePath, 'package.json'), manifest);
  writeFile(path.join(worktreePath, 'package-lock.json'));
  writeJson(path.join(worktreePath, 'apps', 'web', 'package.json'), {
    scripts: { build: 'vite build' },
    dependencies: { vite: '^6.0.0' },
  });
  fs.mkdirSync(path.join(worktreePath, 'apps', 'web', 'node_modules', 'next'), { recursive: true });

  const result = bootstrapWorktreeDeps(worktreePath, {
    repoPath,
    logger: () => {},
  });

  assert.equal(result.bootstrapped, false);
  assert.equal(fs.lstatSync(path.join(worktreePath, 'node_modules')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(worktreePath, 'apps', 'web', 'node_modules')).isSymbolicLink(), true);
  assert.equal(
    fs.realpathSync.native(path.join(worktreePath, 'apps', 'web', 'node_modules')),
    fs.realpathSync.native(path.join(repoPath, 'apps', 'web', 'node_modules')),
  );
});

test('bootstrapWorktreeDeps skips Next workspace node_modules reuse for Turbopack safety', (t) => {
  const worktreePath = makeTempDir(t);
  const repoPath = makeTempDir(t);
  const manifest = {
    private: true,
    workspaces: ['apps/*'],
  };

  writeJson(path.join(repoPath, 'package.json'), manifest);
  writeFile(path.join(repoPath, 'package-lock.json'));
  fs.mkdirSync(path.join(repoPath, 'node_modules', '.bin'), { recursive: true });
  fs.mkdirSync(path.join(repoPath, 'apps', 'web', 'node_modules', '.bin'), { recursive: true });
  writeJson(path.join(repoPath, 'apps', 'web', 'package.json'), {
    scripts: { build: 'next build' },
    dependencies: { next: '^15.0.0' },
  });

  writeJson(path.join(worktreePath, 'package.json'), manifest);
  writeFile(path.join(worktreePath, 'package-lock.json'));
  writeJson(path.join(worktreePath, 'apps', 'web', 'package.json'), {
    scripts: { build: 'next build' },
    dependencies: { next: '^15.0.0' },
  });

  const result = bootstrapWorktreeDeps(worktreePath, {
    repoPath,
    installIfNeeded: false,
    logger: () => {},
  });

  assert.equal(result.bootstrapped, false);
  assert.equal(result.needsInstall, true);
  assert.equal(result.installReason, 'next_turbopack_requires_local_install');
  assert.equal(fs.existsSync(path.join(worktreePath, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(worktreePath, 'apps', 'web', 'node_modules')), false);
});

test('bootstrapWorktreeDeps installs local artifacts for stale Next Turbopack symlinks', (t) => {
  const worktreePath = makeTempDir(t);
  const repoPath = makeTempDir(t);
  const outsideArtifacts = makeTempDir(t);
  const calls = [];
  const manifest = {
    private: true,
    workspaces: ['apps/*', 'packages/*'],
  };

  writeJson(path.join(repoPath, 'package.json'), manifest);
  writeFile(path.join(repoPath, 'pnpm-lock.yaml'));
  fs.mkdirSync(path.join(repoPath, 'node_modules', '.pnpm'), { recursive: true });
  writeJson(path.join(repoPath, 'apps', 'web', 'package.json'), {
    scripts: { build: 'next build' },
    dependencies: { next: '^15.0.0' },
  });
  writeJson(path.join(repoPath, 'packages', 'db', 'package.json'), {
    dependencies: { '@prisma/client': '^6.0.0' },
  });

  writeJson(path.join(worktreePath, 'package.json'), manifest);
  writeFile(path.join(worktreePath, 'pnpm-lock.yaml'));
  writeJson(path.join(worktreePath, 'apps', 'web', 'package.json'), {
    scripts: { build: 'next build' },
    dependencies: { next: '^15.0.0' },
  });
  writeJson(path.join(worktreePath, 'packages', 'db', 'package.json'), {
    dependencies: { '@prisma/client': '^6.0.0' },
  });
  fs.mkdirSync(path.join(worktreePath, 'apps', 'web', 'node_modules'), { recursive: true });
  fs.symlinkSync(
    path.join(repoPath, 'node_modules'),
    path.join(worktreePath, 'node_modules'),
    'dir',
  );
  fs.symlinkSync(
    outsideArtifacts,
    path.join(worktreePath, 'apps', 'web', 'node_modules', 'next'),
    'dir',
  );
  fs.mkdirSync(path.join(repoPath, 'packages', 'db', 'node_modules'), { recursive: true });
  fs.symlinkSync(
    path.join(repoPath, 'packages', 'db', 'node_modules'),
    path.join(worktreePath, 'packages', 'db', 'node_modules'),
    'dir',
  );

  const result = bootstrapWorktreeDeps(worktreePath, {
    repoPath,
    commandRunner: (command, args, cwd) => {
      calls.push({ command, args, cwd });
      fs.mkdirSync(path.join(worktreePath, 'node_modules', '.pnpm'), { recursive: true });
      fs.mkdirSync(path.join(worktreePath, 'apps', 'web', 'node_modules'), { recursive: true });
      fs.mkdirSync(path.join(worktreePath, 'packages', 'db', 'node_modules'), { recursive: true });
      fs.mkdirSync(path.join(worktreePath, 'node_modules', '.pnpm', 'next', 'node_modules', 'next'), { recursive: true });
      fs.symlinkSync(
        path.join(worktreePath, 'node_modules', '.pnpm', 'next', 'node_modules', 'next'),
        path.join(worktreePath, 'apps', 'web', 'node_modules', 'next'),
        'dir',
      );
      return { status: 0, stdout: '', stderr: '' };
    },
    logger: () => {},
  });

  assert.equal(result.bootstrapped, true);
  assert.deepEqual(calls, [
    {
      command: 'pnpm',
      args: ['install', '--frozen-lockfile'],
      cwd: worktreePath,
    },
  ]);
  assert.equal(fs.lstatSync(path.join(worktreePath, 'node_modules')).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(worktreePath, 'apps', 'web', 'node_modules', 'next')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(worktreePath, 'packages', 'db', 'node_modules')).isSymbolicLink(), false);
  assert.equal(
    fs.realpathSync.native(path.join(worktreePath, 'apps', 'web', 'node_modules', 'next'))
      .startsWith(fs.realpathSync.native(worktreePath)),
    true,
  );
});

test('bootstrapWorktreeDeps reuses workspace node_modules from pnpm-workspace.yaml patterns', (t) => {
  const worktreePath = makeTempDir(t);
  const repoPath = makeTempDir(t);
  const manifest = {
    private: true,
  };
  const workspaceYaml = 'packages:\n  - "packages/*"\n';

  writeJson(path.join(repoPath, 'package.json'), manifest);
  writeFile(path.join(repoPath, 'pnpm-lock.yaml'));
  writeFile(path.join(repoPath, 'pnpm-workspace.yaml'), workspaceYaml);
  fs.mkdirSync(path.join(repoPath, 'node_modules', '.pnpm'), { recursive: true });
  fs.mkdirSync(path.join(repoPath, 'packages', 'eslint-config', 'node_modules', '.bin'), { recursive: true });
  writeJson(path.join(repoPath, 'packages', 'eslint-config', 'package.json'), {
    name: '@repo/eslint-config',
    devDependencies: { globals: '^16.5.0' },
  });

  writeJson(path.join(worktreePath, 'package.json'), manifest);
  writeFile(path.join(worktreePath, 'pnpm-lock.yaml'));
  writeFile(path.join(worktreePath, 'pnpm-workspace.yaml'), workspaceYaml);
  writeJson(path.join(worktreePath, 'packages', 'eslint-config', 'package.json'), {
    name: '@repo/eslint-config',
    devDependencies: { globals: '^16.5.0' },
  });

  const result = bootstrapWorktreeDeps(worktreePath, {
    repoPath,
    logger: () => {},
  });

  assert.equal(result.bootstrapped, false);
  assert.equal(
    fs.lstatSync(path.join(worktreePath, 'packages', 'eslint-config', 'node_modules')).isSymbolicLink(),
    true,
  );
  assert.equal(
    fs.realpathSync.native(path.join(worktreePath, 'packages', 'eslint-config', 'node_modules')),
    fs.realpathSync.native(path.join(repoPath, 'packages', 'eslint-config', 'node_modules')),
  );
});

test('bootstrapWorktreeDeps repairs missing workspace node_modules when root install is already reused', (t) => {
  const worktreePath = makeTempDir(t);
  const repoPath = makeTempDir(t);
  const manifest = {
    private: true,
  };
  const workspaceYaml = 'packages:\n  - "packages/*"\n';

  writeJson(path.join(repoPath, 'package.json'), manifest);
  writeFile(path.join(repoPath, 'pnpm-lock.yaml'));
  writeFile(path.join(repoPath, 'pnpm-workspace.yaml'), workspaceYaml);
  fs.mkdirSync(path.join(repoPath, 'node_modules', '.pnpm'), { recursive: true });
  fs.mkdirSync(path.join(repoPath, 'packages', 'eslint-config', 'node_modules', '.bin'), { recursive: true });
  writeJson(path.join(repoPath, 'packages', 'eslint-config', 'package.json'), {
    name: '@repo/eslint-config',
    devDependencies: { globals: '^16.5.0' },
  });

  writeJson(path.join(worktreePath, 'package.json'), manifest);
  writeFile(path.join(worktreePath, 'pnpm-lock.yaml'));
  writeFile(path.join(worktreePath, 'pnpm-workspace.yaml'), workspaceYaml);
  writeJson(path.join(worktreePath, 'packages', 'eslint-config', 'package.json'), {
    name: '@repo/eslint-config',
    devDependencies: { globals: '^16.5.0' },
  });
  fs.symlinkSync(
    path.join(repoPath, 'node_modules'),
    path.join(worktreePath, 'node_modules'),
    'dir',
  );

  const result = bootstrapWorktreeDeps(worktreePath, {
    repoPath,
    logger: () => {},
  });

  assert.equal(result.bootstrapped, false);
  assert.equal(
    fs.lstatSync(path.join(worktreePath, 'packages', 'eslint-config', 'node_modules')).isSymbolicLink(),
    true,
  );
  assert.equal(
    fs.realpathSync.native(path.join(worktreePath, 'packages', 'eslint-config', 'node_modules')),
    fs.realpathSync.native(path.join(repoPath, 'packages', 'eslint-config', 'node_modules')),
  );
});
