import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface RalphConfig {
  agent: {
    path: string;
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
  notification: {
    enabled: boolean;
    channel: string;
    target: string;
  };
}

const DEFAULT_CONFIG: RalphConfig = {
  agent: {
    path: 'codex',
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
      watchDir: '~/openclaw-workspace/docs',
      pattern: 'ez4ielts-*.json',
      settleMs: 2000,
    },
  },
  notification: {
    enabled: false,
    channel: 'feishu',
    target: ''
  }
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeConfig<T extends Record<string, any>>(defaults: T, overrides: Partial<T>): T {
  const merged: Record<string, unknown> = { ...defaults };

  for (const [key, value] of Object.entries(overrides)) {
    const defaultValue = merged[key];

    if (isPlainObject(defaultValue) && isPlainObject(value)) {
      merged[key] = mergeConfig(defaultValue, value);
      continue;
    }

    merged[key] = value;
  }

  return merged as T;
}

export class ConfigManager {
  private configPath: string;
  private config: RalphConfig;

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
      this.save(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }

    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      return mergeConfig(DEFAULT_CONFIG, JSON.parse(content));
    } catch (error) {
      console.error('Failed to load config, using defaults:', error);
      return DEFAULT_CONFIG;
    }
  }

  private save(config: RalphConfig): void {
    const tempPath = `${this.configPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2));
    fs.renameSync(tempPath, this.configPath);
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
      if (!(part in target)) {
        target[part] = {};
      }
      target = target[part];
    }
    
    const lastPart = parts[parts.length - 1];
    target[lastPart] = value;
    
    this.save(this.config);
  }

  list(): RalphConfig {
    return this.config;
  }

  getAll(): RalphConfig {
    return this.config;
  }
}
