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

test('parsePRD supports markdown frontmatter execution metadata and top-level acceptance criteria', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-prd-frontmatter-'));
  const prdPath = path.join(tempDir, 'prd.md');

  try {
    fs.writeFileSync(prdPath, `---
id: prd-markdown-frontmatter
title: Markdown Frontmatter Intake
status: ready
priority: P1
dependencies:
  - upstream-prd
declaredWriteSurface:
  - src/core/task-intake.ts
declaredConflictDomains:
  - prd-ingestion
integrationLane: intake
acceptanceCriteria:
  - Start enqueues the markdown PRD
  - Batch start enqueues the markdown PRD
---

## Context

Implementation details live in prose, but acceptance criteria are explicit.
`);

    const prd = parsePRD(prdPath);

    assert.equal(prd.id, 'prd-markdown-frontmatter');
    assert.equal(prd.title, 'Markdown Frontmatter Intake');
    assert.equal(prd.status, 'ready');
    assert.equal(prd.priority, 'P1');
    assert.deepEqual(prd.dependencies, ['upstream-prd']);
    assert.deepEqual(prd.writeSurface, ['src/core/task-intake.ts']);
    assert.deepEqual(prd.conflictDomains, ['prd-ingestion']);
    assert.equal(prd.integrationLane, 'intake');
    assert.deepEqual(prd.acceptanceCriteria, [
      'Start enqueues the markdown PRD',
      'Batch start enqueues the markdown PRD',
    ]);
    assert.equal(prd.userStories.length, 1);
    assert.equal(prd.userStories[0].id, 'US-001');
    assert.deepEqual(prd.userStories[0].acceptanceCriteria, prd.acceptanceCriteria);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
