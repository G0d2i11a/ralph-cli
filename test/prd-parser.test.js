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
writeSurface:
  - packages/contracts/
conflictDomains:
  - contracts-index
integrationLane: contracts
---

## Additional Context

Body only.
`);

  const prd = parsePRD(prdPath);

  assert.equal(prd.id, 'prd-auth');
  assert.equal(prd.title, 'User Authentication System');
  assert.equal(prd.userStories.length, 2);
  assert.equal(prd.userStories[0].id, 'US-001');
  assert.deepEqual(prd.writeSurface, ['packages/contracts/']);
  assert.deepEqual(prd.conflictDomains, ['contracts-index']);
  assert.equal(prd.integrationLane, 'contracts');
  assert.deepEqual(prd.userStories[1].acceptanceCriteria, [
    'JWT token generation',
    'Session management',
    'Invalid credentials handling',
  ]);
});

test('parsePRD falls back to projectName for JSON PRDs without title', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-prd-json-'));
  const prdPath = path.join(tempDir, 'recording-prd.json');

  fs.writeFileSync(prdPath, JSON.stringify({
    projectName: 'ez4ielts-speaking-recording-transcription',
    description: 'Recording PRD',
    userStories: [
      {
        id: 'US-001',
        title: 'Audit',
        description: 'Audit the current flow',
        acceptanceCriteria: ['done'],
      },
    ],
  }, null, 2));

  const prd = parsePRD(prdPath);

  assert.equal(prd.id, 'recording-prd');
  assert.equal(prd.title, 'ez4ielts-speaking-recording-transcription');
  assert.equal(prd.userStories.length, 1);
  assert.equal(prd.userStories[0].id, 'US-001');
});
