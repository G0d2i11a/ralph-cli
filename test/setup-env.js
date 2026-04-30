const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep the test suite isolated from live Ralph state configured in the shell.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-cli-test-home-'));
const testBin = path.join(testHome, 'bin');
fs.mkdirSync(testBin, { recursive: true });

const pnpmShimPath = path.join(testBin, 'pnpm');
fs.writeFileSync(pnpmShimPath, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
if (args[0] !== 'run' || !args[1]) {
  console.error('test pnpm shim only supports: pnpm run <script>');
  process.exit(1);
}

const result = spawnSync('npm', ['run', args[1], ...args.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  encoding: 'utf-8',
});

if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}

process.exit(result.status ?? 1);
`);
fs.chmodSync(pnpmShimPath, 0o755);

process.env.HOME = testHome;
process.env.PATH = `${testBin}${path.delimiter}${process.env.PATH || ''}`;
delete process.env.RALPH_HOME;

process.on('exit', () => {
  fs.rmSync(testHome, { recursive: true, force: true });
});
