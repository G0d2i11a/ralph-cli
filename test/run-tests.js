const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-cli-test-home-'));
const testFiles = fs.readdirSync(__dirname)
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .map((file) => path.join('test', file));

try {
  const env = {
    ...process.env,
    HOME: testHome,
    USERPROFILE: testHome,
    XDG_CONFIG_HOME: path.join(testHome, '.config'),
    XDG_CACHE_HOME: path.join(testHome, '.cache'),
  };
  delete env.RALPH_HOME;

  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }

  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(testHome, { recursive: true, force: true });
}
