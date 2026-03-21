const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('watch CLI falls back to configured poll interval when --interval is omitted', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-watch-cli-'));
  const configDir = path.join(homeDir, '.ralph');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      runner: {
        pollInterval: 7,
      },
    }, null, 2),
  );

  let child;

  try {
    const output = await new Promise((resolve, reject) => {
      const chunks = [];
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGKILL');
          reject(new Error('watch CLI test timed out'));
        }
      }, 5000);

      child = spawn('node', ['dist/cli.js', 'watch'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: homeDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const onData = (data) => {
        const text = data.toString();
        chunks.push(text);
        if (text.includes('polling every 7s')) {
          child.kill('SIGTERM');
        }
      };

      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        try {
          assert.equal(code, 0);
          resolve(chunks.join(''));
        } catch (error) {
          reject(error);
        }
      });
    });

    assert.match(output, /polling every 7s/);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('watch CLI help advertises the backend option', async () => {
  const output = await new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn('node', ['dist/cli.js', 'watch', '--help'], {
      cwd: path.join(__dirname, '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => chunks.push(data.toString()));
    child.stderr.on('data', (data) => chunks.push(data.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        assert.equal(code, 0);
        resolve(chunks.join(''));
      } catch (error) {
        reject(error);
      }
    });
  });

  assert.match(output, /--backend <name>/);
});
