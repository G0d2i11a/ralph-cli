const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parsePRD } = require('../dist/utils/helpers.js');

test('parsePRD supports markdown frontmatter userStories arrays', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-prd-'));
  const prdPath = path.join(tempDir, 'prd.md');

  fs.writeFileSync(prdPath, `---
id: prd-auth
title: User Authentication System
description: Implement secure user authentication with JWT
userStories:
  - id: US-001
    title: User Registration
    description: As a new user, I want to register an account
    acceptanceCriteria:
      - Email validation
      - Password strength check
      - Duplicate email prevention
  - id: US-002
    title: User Login
    description: As a registered user, I want to log in
    acceptanceCriteria:
      - JWT token generation
      - Session management
      - Invalid credentials handling
dependencies: []
---

## Additional Context

Body only.
`);

  const prd = parsePRD(prdPath);

  assert.equal(prd.id, 'prd-auth');
  assert.equal(prd.title, 'User Authentication System');
  assert.equal(prd.userStories.length, 2);
  assert.equal(prd.userStories[0].id, 'US-001');
  assert.deepEqual(prd.userStories[1].acceptanceCriteria, [
    'JWT token generation',
    'Session management',
    'Invalid credentials handling',
  ]);
});
