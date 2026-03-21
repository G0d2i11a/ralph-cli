import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { UserStory } from '../types/prd';

export type AgentType = 'claude' | 'codex';
export type AgentBackend = 'cli' | 'sdk-runner';

export const DEFAULT_AGENT: AgentType = 'codex';
export const DEFAULT_BACKEND: AgentBackend = 'cli';
const LEGACY_SDK_RUNNER_CLI = '~/Workspace/openclaw/sdk-runners/dist/cli.js';
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

export function isAgentBackend(value: string): value is AgentBackend {
  return value === 'cli' || value === 'sdk-runner';
}

export function resolveAgentBackend(value?: string): AgentBackend {
  if (!value) {
    return DEFAULT_BACKEND;
  }

  if (!isAgentBackend(value)) {
    throw new Error(`Unsupported backend "${value}". Expected "cli" or "sdk-runner".`);
  }

  return value;
}

function looksLikePath(value: string): boolean {
  return value.includes(path.sep) || value.startsWith('.') || value.endsWith('.js');
}

function resolveExistingFile(filePath?: string): string | null {
  if (!filePath || !filePath.trim()) {
    return null;
  }

  const resolved = path.resolve(filePath.trim());
  return fs.existsSync(resolved) ? resolved : null;
}

export function resolveConfiguredBackend(config: AgentConfig): AgentBackend {
  const configuredBackend = config.get('agent.backend');
  const hasExplicitBackend = typeof config.has === 'function'
    ? config.has('agent.backend')
    : typeof configuredBackend === 'string' && configuredBackend.trim().length > 0;

  if (hasExplicitBackend && typeof configuredBackend === 'string' && configuredBackend.trim()) {
    return resolveAgentBackend(configuredBackend.trim());
  }

  const configRunnerPath = config.get('agent.sdkRunnerPath');
  const legacyAgentPath = config.get('agent.path');
  const hasLegacySdkRunner = Boolean(
    process.env.RALPH_SDK_RUNNER_CLI?.trim()
    || (typeof configRunnerPath === 'string' && configRunnerPath.trim())
    || (typeof legacyAgentPath === 'string' && looksLikePath(legacyAgentPath))
  );

  if (!hasExplicitBackend && hasLegacySdkRunner) {
    return 'sdk-runner';
  }

  return resolveAgentBackend(typeof configuredBackend === 'string' ? configuredBackend : undefined);
}

function resolveSdkRunnerCli(config: Pick<ConfigManager, 'get'>): string {
  const configRunnerPath = config.get('agent.sdkRunnerPath');
  const legacyAgentPath = config.get('agent.path');
  const legacyCompatiblePath = typeof legacyAgentPath === 'string' && looksLikePath(legacyAgentPath)
    ? legacyAgentPath
    : undefined;

  const candidates = [
    process.env.RALPH_SDK_RUNNER_CLI,
    typeof configRunnerPath === 'string' ? configRunnerPath : undefined,
    legacyCompatiblePath,
    LEGACY_SDK_RUNNER_CLI,
  ];

  for (const candidate of candidates) {
    const resolved = resolveExistingFile(candidate);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error('Unable to find sdk-runners CLI. Set `RALPH_SDK_RUNNER_CLI` or `agent.sdkRunnerPath` in `~/.ralph/config.json`.');
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

function resolveCodexCliCommand(config: Pick<ConfigManager, 'get'>): string {
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
  ): Promise<{ success: boolean; output: string; sessionId?: string; threadId?: string }> {
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
  ): Promise<{ success: boolean; output: string; sessionId?: string; threadId?: string }> {
    return new Promise((resolve, reject) => {
      let command: string;
      let args: string[];

      if (backend === 'sdk-runner') {
        let sdkRunnerCli: string;
        try {
          sdkRunnerCli = resolveSdkRunnerCli(this.config);
        } catch (error) {
          reject(error);
          return;
        }

        command = 'node';
        args = [
          sdkRunnerCli,
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

        if (agent === 'codex' && state?.threadId) {
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
        TERM: 'dumb'
      };

      if (process.env.LITELLM_MASTER_KEY && !env.OPENAI_API_KEY) {
        env.OPENAI_API_KEY = process.env.LITELLM_MASTER_KEY;
      }

      const timeoutMs = resolveAgentTimeoutMs(this.config);
      let output = '';
      let capturedSessionId: string | undefined;
      let capturedThreadId: string | undefined;
      let settled = false;
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

      const finish = (result: { success: boolean; output: string; sessionId?: string; threadId?: string }) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimers();
        resolve(result);
      };

      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
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
          success: code === 0,
          output,
          sessionId: capturedSessionId,
          threadId: capturedThreadId
        });
      });

      this.process.on('error', (error) => {
        clearTimers();
        const processError = backend === 'cli' && (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(`${error.message}. Install the ${agent} CLI or re-run with --backend sdk-runner.`)
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

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
    }
    if (this.logStream) {
      this.logStream.end();
    }
  }
}
