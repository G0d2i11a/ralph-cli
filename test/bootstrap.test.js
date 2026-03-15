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
