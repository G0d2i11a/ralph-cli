const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('stats --all works without a task id', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-stats-home-'));

  try {
    const result = spawnSync('node', ['dist/cli.js', 'stats', '--all'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: homeDir,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No tasks found/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
