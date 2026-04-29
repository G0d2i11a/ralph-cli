import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { UserStory } from '../types/prd';

export type AgentType = 'claude' | 'codex';
export type AgentBackend = 'cli' | 'agent-runners';
export type CodexConversationScope = 'attempt' | 'story' | 'task';

export type AcceptedAgentBackend = AgentBackend | 'sdk-runner';
export interface AgentRunResult {
  success: boolean;
  output: string;
  sessionId?: string;
  threadId?: string;
  timedOut?: boolean;
  exitCode?: number | null;
}

export const DEFAULT_AGENT: AgentType = 'codex';
export const DEFAULT_BACKEND: AgentBackend = 'cli';
const AGENT_RUNNERS_ENV = 'RALPH_AGENT_RUNNERS_CLI';
const LEGACY_SDK_RUNNER_ENV = 'RALPH_SDK_RUNNER_CLI';
const OPENCLAW_HOME_ENV = 'OPENCLAW_HOME';
const FORCE_KILL_GRACE_MS = 5000;

type AgentConfig = Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'has'>>;

export function isAgentType(value: string): value is AgentType {
  return value === 'claude' || value === 'codex';
}

export function resolveAgentType(value?: string): AgentType {
  if (!value) {
    return DEFAULT_AGENT;
  }

  if (!isAgentType(value)) {
    throw new Error(`Unsupported agent "${value}". Expected "claude" or "codex".`);
  }

  return value;
}

export function isAgentBackend(value: string): value is AcceptedAgentBackend {
  return value === 'cli' || value === 'agent-runners' || value === 'sdk-runner';
}

export function resolveAgentBackend(value?: string): AgentBackend {
  if (!value) {
    return DEFAULT_BACKEND;
  }

  if (!isAgentBackend(value)) {
    throw new Error(`Unsupported backend "${value}". Expected "cli" or "agent-runners" (legacy alias: "sdk-runner").`);
  }

  return value === 'sdk-runner' ? 'agent-runners' : value;
}

function looksLikeLegacyAgentRunnerPath(value: string): boolean {
  return value.trim().endsWith('.js');
}

function resolveExistingFile(filePath?: string): string | null {
  if (!filePath || !filePath.trim()) {
    return null;
  }

  const resolved = path.resolve(filePath.trim());
  return fs.existsSync(resolved) ? resolved : null;
}

function resolveOpenclawHome(): string {
  const configuredHome = process.env[OPENCLAW_HOME_ENV]?.trim();
  return configuredHome || path.join(os.homedir(), 'Workspace', 'openclaw');
}

function defaultAgentRunnersCli(): string {
  return path.join(resolveOpenclawHome(), 'agent-runners', 'dist', 'cli.js');
}

function legacySdkRunnersCli(): string {
  return path.join(resolveOpenclawHome(), 'sdk-runners', 'dist', 'cli.js');
}

export function resolveConfiguredBackend(config: AgentConfig): AgentBackend {
  const configuredBackend = config.get('agent.backend');
  const hasExplicitBackend = typeof config.has === 'function'
    ? config.has('agent.backend')
    : typeof configuredBackend === 'string' && configuredBackend.trim().length > 0;

  if (hasExplicitBackend && typeof configuredBackend === 'string' && configuredBackend.trim()) {
    return resolveAgentBackend(configuredBackend.trim());
  }

  const configuredAgentRunnersPath = config.get('agent.agentRunnersPath');
  const configRunnerPath = config.get('agent.sdkRunnerPath');
  const legacyAgentPath = config.get('agent.path');
  const hasLegacySdkRunner = Boolean(
    process.env[AGENT_RUNNERS_ENV]?.trim()
    || process.env[LEGACY_SDK_RUNNER_ENV]?.trim()
    || (typeof configuredAgentRunnersPath === 'string' && configuredAgentRunnersPath.trim())
    || (typeof configRunnerPath === 'string' && configRunnerPath.trim())
    || (typeof legacyAgentPath === 'string' && looksLikeLegacyAgentRunnerPath(legacyAgentPath))
  );

  if (!hasExplicitBackend && hasLegacySdkRunner) {
    return 'agent-runners';
  }

  return resolveAgentBackend(typeof configuredBackend === 'string' ? configuredBackend : undefined);
}

function resolveAgentRunnersCli(config: Pick<ConfigManager, 'get'>): string {
  const configuredAgentRunnersPath = config.get('agent.agentRunnersPath');
  const configRunnerPath = config.get('agent.sdkRunnerPath');
  const legacyAgentPath = config.get('agent.path');
  const legacyCompatiblePath = typeof legacyAgentPath === 'string' && looksLikeLegacyAgentRunnerPath(legacyAgentPath)
    ? legacyAgentPath
    : undefined;

  const candidates = [
    process.env[AGENT_RUNNERS_ENV],
    typeof configuredAgentRunnersPath === 'string' ? configuredAgentRunnersPath : undefined,
    process.env[LEGACY_SDK_RUNNER_ENV],
    typeof configRunnerPath === 'string' ? configRunnerPath : undefined,
    legacyCompatiblePath,
    defaultAgentRunnersCli(),
    legacySdkRunnersCli(),
  ];

  for (const candidate of candidates) {
    const resolved = resolveExistingFile(candidate);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error('Unable to find agent-runners CLI. Set `RALPH_AGENT_RUNNERS_CLI` or `agent.agentRunnersPath` in `RALPH_HOME/config.json` (default: `~/.ralph/config.json`). Legacy `RALPH_SDK_RUNNER_CLI` and `agent.sdkRunnerPath` are also supported.');
}

function resolveAgentTimeoutMs(config: Pick<ConfigManager, 'get'>): number {
  const configuredTimeout = Number(config.get('agent.timeout'));

  if (!Number.isFinite(configuredTimeout)) {
    return 600_000;
  }

  if (configuredTimeout <= 0) {
    return 0;
  }

  return configuredTimeout * 1000;
}

function resolveWorktreeGitEnv(worktreePath: string): Partial<NodeJS.ProcessEnv> {
  const localGitDir = path.join(worktreePath, '.git-local');

  if (!fs.existsSync(localGitDir) || !fs.statSync(localGitDir).isDirectory()) {
    return {};
  }

  return {
    GIT_DIR: localGitDir,
    GIT_WORK_TREE: worktreePath,
  };
}

export function resolveCodexCliCommand(config: Pick<ConfigManager, 'get'>): string {
  const configuredPath = config.get('agent.path');

  if (typeof configuredPath === 'string' && configuredPath.trim()) {
    const candidate = configuredPath.trim();

    if (!candidate.endsWith('.js')) {
      return candidate;
    }
  }

  return 'codex';
}

interface AgentRunState {
  sessionId?: string;
  threadId?: string;
  storyId?: string;
  threadStoryId?: string;
}

export function resolveCodexConversationScope(config: Pick<ConfigManager, 'get'>): CodexConversationScope {
  const configuredScope = config.get('agent.codexConversationScope');

  if (configuredScope === 'attempt' || configuredScope === 'story' || configuredScope === 'task') {
    return configuredScope;
  }

  return 'story';
}

export class AgentRunner {
  private process?: ChildProcess;
  private logStream?: fs.WriteStream;
  private config = new ConfigManager();

  async runUserStory(
    us: UserStory,
    worktreePath: string,
    agent: AgentType,
    logPath: string,
    backendOrState?: AgentBackend | AgentRunState,
    maybeState?: AgentRunState,
  ): Promise<AgentRunResult> {
    const prompt = this.generatePrompt(us);
    const backend = typeof backendOrState === 'string'
      ? resolveAgentBackend(backendOrState)
      : resolveConfiguredBackend(this.config);
    const state = typeof backendOrState === 'string' ? maybeState : backendOrState;

    return this.execAgent(agent, prompt, worktreePath, logPath, backend, state);
  }

  private generatePrompt(us: UserStory): string {
    return `
# User Story: ${us.title}

${us.description}

## Acceptance Criteria:
${us.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')}

Please implement this user story. Make sure all acceptance criteria are met.
Do not commit your changes. Instead, leave the worktree ready for a separate finisher step and include a suggested commit message in your final summary.
`.trim();
  }

  private async execAgent(
    agent: AgentType,
    prompt: string,
    worktreePath: string,
    logPath: string,
    backend: AgentBackend,
    state?: AgentRunState
  ): Promise<AgentRunResult> {
    return new Promise((resolve, reject) => {
      let command: string;
      let args: string[];

      if (backend === 'agent-runners') {
        let agentRunnersCli: string;
        try {
          agentRunnersCli = resolveAgentRunnersCli(this.config);
        } catch (error) {
          reject(error);
          return;
        }

        command = 'node';
        args = [
          agentRunnersCli,
          agent,
          '--prompt', prompt,
          '--cwd', worktreePath,
          '--log', logPath,
        ];

        if (agent === 'claude') {
          const model = this.config.get('agent.model') || 'claude-opus-4-6';
          args.push('--model', model);

          if (state?.sessionId) {
            args.push('--resume', state.sessionId);
          }
        }

        if (agent === 'codex' && this.shouldResumeCodexThread(state)) {
          args.push('--resume-thread', state.threadId);
        }
      } else if (agent === 'claude') {
        const model = this.config.get('agent.model') || 'claude-opus-4-6-thinking-xchai';
        command = 'claude';
        args = [
          '-p',
          prompt,
          '--model',
          model,
          '--dangerously-skip-permissions',
          '--permission-mode',
          'bypassPermissions',
        ];
      } else {
        command = resolveCodexCliCommand(this.config);
        args = ['exec', prompt, '--full-auto'];
      }

      const logDir = path.dirname(logPath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      console.log(`[Agent] Starting ${agent} agent via ${backend}`);
      console.log(`[Agent] Command: ${command} ${args.join(' ')}`);
      console.log(`[Agent] Worktree: ${worktreePath}`);
      console.log(`[Agent] Log path: ${logPath}`);

      this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
      this.logStream.write(`\n=== Agent execution started at ${new Date().toISOString()} ===\n`);
      this.logStream.write(`Backend: ${backend}\n`);
      this.logStream.write(`Command: ${command} ${args.join(' ')}\n\n`);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CI: 'true',
        TERM: 'dumb',
        ...resolveWorktreeGitEnv(worktreePath),
      };

      if (process.env.LITELLM_MASTER_KEY && !env.OPENAI_API_KEY) {
        env.OPENAI_API_KEY = process.env.LITELLM_MASTER_KEY;
      }

      const timeoutMs = resolveAgentTimeoutMs(this.config);
      let output = '';
      let capturedSessionId: string | undefined;
      let capturedThreadId: string | undefined;
      let settled = false;
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let forceKillHandle: NodeJS.Timeout | undefined;

      const clearTimers = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        if (forceKillHandle) {
          clearTimeout(forceKillHandle);
          forceKillHandle = undefined;
        }
      };

      this.process = spawn(command, args, {
        cwd: worktreePath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      });

      const finish = (result: AgentRunResult) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimers();
        resolve(result);
      };

      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          const timeoutSeconds = timeoutMs / 1000;
          const formattedTimeout = Number.isInteger(timeoutSeconds)
            ? String(timeoutSeconds)
            : timeoutSeconds.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
          const timeoutMessage = `[Agent] Timed out after ${formattedTimeout}s; sending SIGTERM`;
          output += `\n${timeoutMessage}\n`;
          console.error(timeoutMessage);
          this.logStream?.write(`\n${timeoutMessage}\n`);
          this.process?.kill('SIGTERM');

          forceKillHandle = setTimeout(() => {
            const killMessage = '[Agent] Process did not exit after SIGTERM; sending SIGKILL';
            output += `\n${killMessage}\n`;
            console.error(killMessage);
            this.logStream?.write(`\n${killMessage}\n`);
            this.process?.kill('SIGKILL');
          }, FORCE_KILL_GRACE_MS);
        }, timeoutMs);
      }

      this.process.stdout?.on('data', (data) => {
        const text = data.toString();
        output += text;

        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.kind === 'final') {
              if (event.payload?.sessionId) {
                capturedSessionId = event.payload.sessionId;
              }
              if (event.payload?.threadId) {
                capturedThreadId = event.payload.threadId;
              }
            }
          } catch {
            // Not JSON, just log as text.
          }
        }

        console.log(`[Agent] stdout: ${text}`);
        this.logStream?.write(text);
      });

      this.process.stderr?.on('data', (data) => {
        const text = data.toString();
        output += text;
        console.log(`[Agent] stderr: ${text}`);
        this.logStream?.write(text);
      });

      this.process.on('close', (code) => {
        console.log(`[Agent] Process exited with code ${code}`);
        this.logStream?.write(`\n=== Agent execution ended at ${new Date().toISOString()} with code ${code} ===\n`);
        this.logStream?.end();
        finish({
          success: !timedOut && code === 0,
          output,
          sessionId: capturedSessionId,
          threadId: capturedThreadId,
          timedOut,
          exitCode: code,
        });
      });

      this.process.on('error', (error) => {
        clearTimers();
        const processError = backend === 'cli' && (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(`${error.message}. Install the ${agent} CLI or re-run with --backend agent-runners.`)
          : error;
        console.error(`[Agent] Process error: ${processError.message}`);
        this.logStream?.write(`\nERROR: ${processError.message}\n`);
        this.logStream?.end();
        if (!settled) {
          settled = true;
          reject(processError);
        }
      });
    });
  }

  private shouldResumeCodexThread(state?: AgentRunState): state is AgentRunState & { threadId: string } {
    if (!state?.threadId) {
      return false;
    }

    const scope = resolveCodexConversationScope(this.config);
    if (scope === 'attempt') {
      return false;
    }

    if (scope === 'task') {
      return true;
    }

    return Boolean(state.storyId && state.threadStoryId === state.storyId);
  }

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
    }
    if (this.logStream) {
      this.logStream.end();
    }
  }
}
