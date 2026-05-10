const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function writeManagerState(ralphHome, repoPath) {
  const stateDir = path.join(ralphHome, 'manager');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
    pid: process.pid,
    status: 'running',
    startedAt: Date.now() - 1000,
    updatedAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    pollIntervalMs: 10000,
    autoIngestEnabled: false,
    repo: repoPath,
    agent: 'codex',
    hostname: 'test-host',
    argv: [process.execPath, '/tmp/ralph-cli/dist/cli.js', 'manager', '--repo', repoPath],
  }, null, 2));
}

function writeLaunchdPlist(homeDir, label, ralphHome, repoPath) {
  const launchDir = path.join(homeDir, 'Library', 'LaunchAgents');
  fs.mkdirSync(launchDir, { recursive: true });
  const plistPath = path.join(launchDir, `${label}.plist`);
  fs.writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>/tmp/ralph-cli/dist/cli.js</string>
    <string>manager</string>
    <string>--repo</string>
    <string>${repoPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RALPH_HOME</key>
    <string>${ralphHome}</string>
  </dict>
</dict>
</plist>
`);
}

function writeMenubarPlist(homeDir, label) {
  const launchDir = path.join(homeDir, 'Library', 'LaunchAgents');
  fs.mkdirSync(launchDir, { recursive: true });
  fs.writeFileSync(path.join(launchDir, `${label}.plist`), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/tmp/ralph-cli/tools/ralph-menubar/RalphMenuBar</string>
  </array>
</dict>
</plist>
`);
}

test('repo manager registry detects active duplicate managers for the same repo', () => {
  const previousHome = process.env.HOME;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-repo-manager-registry-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-repo-manager-registry-repo-'));
  const firstHome = path.join(homeDir, '.ralph-first');
  const secondHome = path.join(homeDir, '.ralph-second');

  try {
    process.env.HOME = homeDir;
    writeManagerState(firstHome, repoDir);
    writeManagerState(secondHome, repoDir);
    writeLaunchdPlist(homeDir, 'com.test.ralph.first', firstHome, repoDir);
    writeLaunchdPlist(homeDir, 'com.test.ralph.second', secondHome, repoDir);

    const {
      assertNoDuplicateRepoManagers,
      detectDuplicateRepoManagers,
    } = require('../dist/core/repo-manager-registry.js');
    const report = detectDuplicateRepoManagers({
      repoPath: repoDir,
      currentRalphHome: firstHome,
    });

    assert.equal(report.duplicateRepoManagers, true);
    assert.equal(report.activeClaims.length, 2);
    assert.equal(report.otherActiveClaims.length, 1);
    assert.throws(
      () => assertNoDuplicateRepoManagers({
        repoPath: repoDir,
        currentRalphHome: firstHome,
        operation: 'start test manager',
      }),
      /already managed by another active Ralph home/,
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('repo manager registry ignores non-manager Ralph launchd plists and realpath-equivalent homes', () => {
  const previousHome = process.env.HOME;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-repo-manager-registry-home-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-repo-manager-registry-repo-'));
  const realHome = path.join(homeDir, 'real-ralph-home');
  const linkHome = path.join(homeDir, '.ralph-link');

  try {
    process.env.HOME = homeDir;
    fs.mkdirSync(realHome, { recursive: true });
    fs.symlinkSync(realHome, linkHome, 'dir');
    writeManagerState(realHome, repoDir);
    writeLaunchdPlist(homeDir, 'com.test.ralph.manager', realHome, repoDir);
    writeLaunchdPlist(homeDir, 'com.test.ralph.manager.link', linkHome, repoDir);
    writeMenubarPlist(homeDir, 'com.test.ralph.menubar');

    const {
      detectDuplicateRepoManagers,
      listLaunchdManagerCandidates,
    } = require('../dist/core/repo-manager-registry.js');
    const candidates = listLaunchdManagerCandidates({ homeDir });
    const report = detectDuplicateRepoManagers({
      repoPath: repoDir,
      currentRalphHome: linkHome,
      homeDir,
    });

    assert.equal(candidates.some((candidate) => candidate.label === 'com.test.ralph.menubar'), false);
    assert.equal(report.duplicateRepoManagers, false);
    assert.equal(report.activeClaims.length, 1);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
