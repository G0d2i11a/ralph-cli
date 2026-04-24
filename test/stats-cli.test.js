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

test('stats json prefers structured event and story progress data', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-stats-events-home-'));
  const taskDir = path.join(homeDir, '.ralph', 'tasks', 'event-task');
  const prdPath = path.join(taskDir, 'prd.json');
  const eventLogPath = path.join(taskDir, 'events.jsonl');

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(prdPath, JSON.stringify({
      id: 'event-prd',
      title: 'Event PRD',
      description: '',
      userStories: [
        {
          id: 'US-001',
          title: 'Event story',
          description: '',
          acceptanceCriteria: [],
        },
      ],
      dependencies: [],
    }, null, 2));
    fs.writeFileSync(eventLogPath, [
      JSON.stringify({
        timestamp: 1_000,
        taskId: 'event-task',
        type: 'story_attempt_started',
        storyId: 'US-001',
      }),
      JSON.stringify({
        timestamp: 6_000,
        taskId: 'event-task',
        type: 'story_passed',
        storyId: 'US-001',
      }),
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
      id: 'event-task',
      prdPath,
      status: 'completed',
      startTime: 1_000,
      endTime: 6_000,
      completedUS: ['US-001'],
      storyProgress: [
        {
          id: 'US-001',
          status: 'passed',
          attempts: 2,
          updatedAt: 6_000,
        },
      ],
      worktree: '/tmp/worktree',
      logPath: path.join(taskDir, 'agent.log'),
      eventLogPath,
      agent: 'codex',
      repoPath: '/tmp/repo',
      loopCount: 0,
      consecutiveNoProgress: 0,
      consecutiveErrors: 0,
      lastProgressTime: 6_000,
      lastFilesChanged: 1,
    }, null, 2));

    const result = spawnSync('node', ['dist/cli.js', 'stats', 'event-task', '--format', 'json'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: homeDir,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.userStories[0].duration, 5);
    assert.equal(output.userStories[0].iterations, 2);
    assert.equal(output.userStories[0].status, 'completed');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
