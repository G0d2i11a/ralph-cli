const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOperationalArtifactExcludePathspecs,
  filterOperationalArtifactPaths,
  isOperationalArtifactPath,
} = require('../dist/core/operational-artifacts.js');

test('operational artifact filters treat quarantined Next builds as generated runtime output', () => {
  assert.equal(isOperationalArtifactPath('apps/web/.next.stale-build-20260508_022301/lock'), true);
  assert.equal(isOperationalArtifactPath('apps/web/.next.stale-build/cache/config.json'), true);
  assert.equal(isOperationalArtifactPath('apps/web/app/page.tsx'), false);

  assert.deepEqual(
    filterOperationalArtifactPaths([
      'apps/web/.next.stale-build-20260508_022301/lock',
      'apps/web/app/page.tsx',
      'apps/web/.turbo/cache.json',
    ]),
    ['apps/web/app/page.tsx'],
  );

  assert.ok(buildOperationalArtifactExcludePathspecs().includes(':(glob,exclude)**/.next.stale-build*/**'));
});
