const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-test-home-'));

process.env.HOME = testHome;
delete process.env.RALPH_HOME;

process.once('exit', () => {
  fs.rmSync(testHome, { recursive: true, force: true });
});
