import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { resolveCodexCliCommand, resolveConfiguredBackend } from '../core/agent';
import { getManagerStatus } from '../core/manager-state';
import { resolveRalphHome } from '../core/paths';

interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

function commandExists(command: string): boolean {
  const trimmed = command.trim();

  if (trimmed.includes(path.sep) || trimmed.startsWith('.')) {
    const resolved = path.resolve(trimmed);
    try {
      fs.accessSync(resolved, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  try {
    execFileSync('which', [trimmed], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function resolveFile(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  return path.resolve(value.trim());
}

function isGitRepo(repoPath: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function hasDirtyWorktree(repoPath: string): boolean {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

function hasWritableRalphHome(ralphHome: string): boolean {
  try {
    fs.mkdirSync(ralphHome, { recursive: true });
    fs.accessSync(ralphHome, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function doctorCommand(options: { repo?: string } = {}): Promise<void> {
  const repoPath = path.resolve(options.repo || process.cwd());
  const ralphHome = resolveRalphHome();
  const configManager = new ConfigManager({ ralphHome });
  const backend = resolveConfiguredBackend(configManager);
  const codexCommand = resolveCodexCliCommand(configManager);
  const repoIsGit = isGitRepo(repoPath);
  const repoIsDirty = repoIsGit && hasDirtyWorktree(repoPath);
  const usesIntegrationWorktree = configManager.get('merge.useIntegrationWorktree') !== false;
  const managerStatus = getManagerStatus({ ralphHome });
  const ralphHomeWritable = hasWritableRalphHome(ralphHome);
  const managerCheckOk = !managerStatus.stateExists
    || managerStatus.state?.status !== 'running'
    || (managerStatus.processRunning && !managerStatus.heartbeatStale);
  const agentRunnersPath = resolveFile(configManager.get('agent.agentRunnersPath'))
    || resolveFile(configManager.get('agent.sdkRunnerPath'))
    || resolveFile(process.env.RALPH_AGENT_RUNNERS_CLI)
    || resolveFile(process.env.RALPH_SDK_RUNNER_CLI);

  const checks: DoctorCheck[] = [
    {
      name: 'ralph.home',
      ok: ralphHomeWritable,
      message: ralphHomeWritable
        ? `Ralph home is writable: ${ralphHome}`
        : `Ralph home is not writable: ${ralphHome}`,
    },
    {
      name: 'git',
      ok: commandExists('git'),
      message: commandExists('git') ? 'git is available' : 'git was not found in PATH',
    },
    {
      name: 'repo',
      ok: repoIsGit,
      message: repoIsGit ? `${repoPath} is a git repo` : `${repoPath} is not a git repo`,
    },
    {
      name: 'repo.clean',
      ok: !repoIsGit || !repoIsDirty || usesIntegrationWorktree,
      message: !repoIsGit
        ? 'skipped because repo check failed'
        : repoIsDirty && usesIntegrationWorktree
          ? 'repo has uncommitted changes; integration worktree mode can still merge and will defer target sync if needed'
          : repoIsDirty
            ? 'repo has uncommitted changes; live-checkout merge may be unsafe'
          : 'repo working tree is clean',
    },
    {
      name: 'codex',
      ok: commandExists(codexCommand),
      message: commandExists(codexCommand)
        ? `${codexCommand} is available`
        : `${codexCommand} was not found or is not executable`,
    },
    {
      name: 'backend',
      ok: backend === 'cli' || Boolean(agentRunnersPath && fs.existsSync(agentRunnersPath)),
      message: backend === 'cli'
        ? 'cli backend selected'
        : agentRunnersPath && fs.existsSync(agentRunnersPath)
          ? `agent-runners backend available at ${agentRunnersPath}`
          : 'agent-runners backend selected but no valid CLI path was found',
    },
    {
      name: 'config.runner',
      ok: Number(configManager.get('runner.maxConcurrent')) >= 1,
      message: `maxConcurrent=${configManager.get('runner.maxConcurrent')}`,
    },
    {
      name: 'manager',
      ok: managerCheckOk,
      message: managerStatus.message,
    },
  ];

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    ralphHome,
    repoPath,
    backend,
    manager: managerStatus,
    checks,
  }));

  if (!ok) {
    process.exitCode = 1;
  }
}
