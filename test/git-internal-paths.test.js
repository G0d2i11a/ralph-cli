const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterGitInternalPaths,
  isGitInternalPath,
  buildGitInternalExcludePathspecs,
} = require('../dist/core/git-internal-paths.js');

test('isGitInternalPath treats Ralph probe/admin paths as internal', () => {
  assert.equal(isGitInternalPath('.git-local-admin'), true);
  assert.equal(isGitInternalPath('.git-local-admin/index'), true);
  assert.equal(isGitInternalPath('.git-local-objects/pack/foo'), true);
  assert.equal(isGitInternalPath('.ralph-integration-probe/main'), true);
  assert.equal(isGitInternalPath('src/app.ts'), false);
});

test('filterGitInternalPaths strips Ralph probe/admin paths but keeps user files', () => {
  assert.deepEqual(
    filterGitInternalPaths([
      '.git-local/MERGE_HEAD',
      '.git-local-admin/index',
      '.git-local-objects/pack/tmp',
      '.ralph-integration-probe/main',
      '.gitignore',
      'packages/control-plane/src/dashboard.ts',
      'packages/control-plane/src/dashboard.ts',
    ]),
    [
      '.gitignore',
      'packages/control-plane/src/dashboard.ts',
    ],
  );
});

test('buildGitInternalExcludePathspecs includes Ralph probe/admin roots', () => {
  const pathspecs = buildGitInternalExcludePathspecs();
  assert.match(pathspecs.join('\n'), /\.git-local-admin/);
  assert.match(pathspecs.join('\n'), /\.git-local-objects/);
  assert.match(pathspecs.join('\n'), /\.ralph-integration-probe/);
});
