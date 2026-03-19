import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../config/manager';
import { UserStory } from '../types/prd';

export type AgentType = 'claude' | 'codex';

export const DEFAULT_AGENT: AgentType = 'codex';

export function isAgentType(value: string): value is AgentType {
  return value === 'claude' || value === 'codex';
}

export function resolveAgentType(value?: string): AgentType {
  if (!value) {
    return DEFAULT_AGENT;
  }

  if (!isAgentType(value)) {
    throw new Error(`Unsupported agent \"${value}\". Expected \"claude\" or \"codex\".`);
  }

  return value;
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
    sessionId?: string
  ): Promise<{ success: boolean; output: string; sessionId?: string }> {
    const prompt = this.generatePrompt(us);
    return this.execAgent(agent, prompt, worktreePath, logPath, sessionId);
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
    sessionId?: string
  ): Promise<{ success: boolean; output: string; sessionId?: string }> {
    return new Promise((resolve, reject) => {
      let command: string;
      let args: string[];

      if (agent === 'claude') {
        const model = this.config.get('agent.model') || 'claude-opus-4-6';
        command = 'node';
        args = [
          '~/Workspace/openclaw/sdk-runners/dist/cli.js',
          'claude',
          '--prompt', prompt,
          '--cwd', worktreePath,
          '--model', model,
          '--log', logPath
        ];

        // Add session continuation if available
        if (sessionId) {
          args.push('--resume', sessionId);
        }
      } else {
        command = 'codex';
        args = ['exec', prompt, '--full-auto'];
      }

      // Ensure log directory exists
      const logDir = path.dirname(logPath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      console.log(`[Agent] Starting ${agent} agent`);
      console.log(`[Agent] Command: ${command} ${args.join(' ')}`);
      console.log(`[Agent] Worktree: ${worktreePath}`);
      console.log(`[Agent] Log path: ${logPath}`);

      this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
      this.logStream.write(`\n=== Agent execution started at ${new Date().toISOString()} ===\n`);
      this.logStream.write(`Command: ${command} ${args.join(' ')}\n\n`);
      
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || 'http://localhost:4000/v1',
        // Ensure Claude Code doesn't try to use TTY
        CI: 'true',
        TERM: 'dumb'
      };

      if (process.env.LITELLM_MASTER_KEY) {
        env.OPENAI_API_KEY = process.env.LITELLM_MASTER_KEY;
      }

      this.process = spawn(command, args, {
        cwd: worktreePath,
        stdio: ['ignore', 'pipe', 'pipe'],  // stdin ignored, stdout/stderr piped
        env
      });

      let output = '';
      let capturedSessionId: string | undefined;

      this.process.stdout?.on('data', (data) => {
        const text = data.toString();
        output += text;

        // Parse JSON events line by line to capture sessionId
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.kind === 'final' && event.payload?.sessionId) {
              capturedSessionId = event.payload.sessionId;
            }
          } catch {
            // Not JSON, just log as text
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
        resolve({
          success: code === 0,
          output,
          sessionId: capturedSessionId
        });
      });

      this.process.on('error', (error) => {
        console.error(`[Agent] Process error: ${error.message}`);
        this.logStream?.write(`\nERROR: ${error.message}\n`);
        this.logStream?.end();
        reject(error);
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
