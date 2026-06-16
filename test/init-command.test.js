const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function repoRoot() {
  return path.resolve(__dirname, '..');
}

test('init creates a Ralph home and registers the project with Ralph Menu Bar', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-init-'));
  const homeDir = path.join(root, 'home');
  const repoDir = path.join(root, 'repo');
  const ralphHome = path.join(root, 'ralph-home');

  try {
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });

    const result = spawnSync(process.execPath, [
      'dist/cli.js',
      '--home', ralphHome,
      'init',
      '--repo', repoDir,
      '--name', 'Demo Project',
      '--max-concurrent', '2',
    ], {
      cwd: repoRoot(),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const registeredRalphHome = fs.realpathSync.native(ralphHome);
    const registeredRepoDir = fs.realpathSync.native(repoDir);
    const output = JSON.parse(result.stdout);
    assert.equal(output.success, true);
    assert.equal(output.projectName, 'Demo Project');
    assert.equal(output.ralphHome, ralphHome);
    assert.equal(output.menubarRegistered, true);
    assert.match(output.warnings.join('\n'), /no valid HEAD/);

    const ralphConfig = JSON.parse(fs.readFileSync(path.join(ralphHome, 'config.json'), 'utf-8'));
    assert.equal(ralphConfig.project.name, 'Demo Project');
    assert.equal(ralphConfig.project.repoPath, repoDir);
    assert.equal(ralphConfig.runner.maxConcurrent, 2);
    assert.equal(ralphConfig.agent.path, 'codex');
    assert.equal(ralphConfig.agent.backend, 'cli');
    assert.equal(fs.existsSync(path.join(ralphHome, 'tasks')), true);
    assert.equal(fs.existsSync(path.join(ralphHome, 'manager')), true);
    assert.equal(fs.existsSync(path.join(ralphHome, 'locks')), true);
    assert.equal(fs.existsSync(path.join(ralphHome, 'logs')), true);

    const menubarConfigPath = path.join(homeDir, 'Library', 'Application Support', 'RalphMenuBar', 'config.json');
    const menubarConfig = JSON.parse(fs.readFileSync(menubarConfigPath, 'utf-8'));
    assert.equal(menubarConfig.autoDiscoverHomes, false);
    assert.equal(menubarConfig.selectedProjectId, registeredRalphHome);
    assert.deepEqual(menubarConfig.projects, [{
      name: 'Demo Project',
      ralphHome: registeredRalphHome,
      repoPath: registeredRepoDir,
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
