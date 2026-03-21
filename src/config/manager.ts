import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface RalphConfig {
  agent: {
    backend: string;
    path: string;
    agentRunnersPath: string;
    sdkRunnerPath: string;
    timeout: number;
    model: string;
  };
  runner: {
    maxConcurrent: number;
    stagnationTimeout: number;
    pollInterval: number;
  };
  ingestion: {
    ez4ielts: {
      enabled: boolean;
      watchDir: string;
      pattern: string;
      settleMs: number;
    };
  };
}

const DEFAULT_CONFIG: RalphConfig = {
  agent: {
    backend: 'cli',
    path: 'codex',
    agentRunnersPath: process.env.RALPH_AGENT_RUNNERS_CLI || process.env.RALPH_SDK_RUNNER_CLI || '',
    sdkRunnerPath: process.env.RALPH_SDK_RUNNER_CLI || '',
    timeout: 600,
    model: 'claude-opus-4-6-thinking-xchai'
  },
  runner: {
    maxConcurrent: 3,
    stagnationTimeout: 1800,
    pollInterval: 10
  },
  ingestion: {
    ez4ielts: {
      enabled: false,
      watchDir: process.env.RALPH_EZ4IELTS_WATCH_DIR || '',
      pattern: 'ez4ielts-*.json',
      settleMs: 2000,
    },
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeConfig<T extends Record<string, any>>(defaults: T, overrides: Partial<T>): T {
  const merged: Record<string, unknown> = { ...defaults };
  const overrideRecord: Record<string, unknown> = isPlainObject(overrides) ? overrides : {};

  for (const [key, defaultValue] of Object.entries(defaults)) {
    const overrideValue = overrideRecord[key];

    if (overrideValue === undefined) {
      continue;
    }

    if (isPlainObject(defaultValue) && isPlainObject(overrideValue)) {
      merged[key] = mergeConfig(defaultValue, overrideValue);
      continue;
    }

    merged[key] = overrideValue;
  }

  return merged as T;
}

export class ConfigManager {
  private configPath: string;
  private config: RalphConfig;
  private rawConfig: Record<string, unknown> = {};

  constructor() {
    const ralphDir = path.join(os.homedir(), '.ralph');
    if (!fs.existsSync(ralphDir)) {
      fs.mkdirSync(ralphDir, { recursive: true });
    }
    this.configPath = path.join(ralphDir, 'config.json');
    this.config = this.load();
  }

  private load(): RalphConfig {
    if (!fs.existsSync(this.configPath)) {
      const config = cloneConfig(DEFAULT_CONFIG);
      this.rawConfig = cloneConfig(config) as unknown as Record<string, unknown>;
      this.save(config);
      return config;
    }

    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(content);
      this.rawConfig = isPlainObject(parsed) ? parsed : {};
      return mergeConfig(DEFAULT_CONFIG, this.rawConfig as Partial<RalphConfig>);
    } catch (error) {
      console.error('Failed to load config, using defaults:', error);
      this.rawConfig = {};
      return cloneConfig(DEFAULT_CONFIG);
    }
  }

  private save(config: RalphConfig): void {
    const tempPath = `${this.configPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2));
    fs.renameSync(tempPath, this.configPath);
    this.rawConfig = cloneConfig(config) as unknown as Record<string, unknown>;
  }

  get(key: string): any {
    const parts = key.split('.');
    let value: any = this.config;

    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        return undefined;
      }
    }

    return value;
  }

  set(key: string, value: any): void {
    const parts = key.split('.');
    let target: any = this.config;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in target) || !isPlainObject(target[part])) {
        target[part] = {};
      }
      target = target[part];
    }

    const lastPart = parts[parts.length - 1];
    target[lastPart] = value;

    this.save(this.config);
  }

  has(key: string): boolean {
    const parts = key.split('.');
    let value: unknown = this.rawConfig;

    for (const part of parts) {
      if (!isPlainObject(value) || !(part in value)) {
        return false;
      }

      value = value[part];
    }

    return true;
  }

  list(): RalphConfig {
    return this.config;
  }

  getAll(): RalphConfig {
    return this.config;
  }
}
