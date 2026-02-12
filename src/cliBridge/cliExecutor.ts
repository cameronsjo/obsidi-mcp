import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { platform } from 'os';
import { createLogger } from '../logger';
import { getEnhancedPath } from '../claudePath';

const log = createLogger('CLIExecutor');

export interface CLIExecutorConfig {
  /** Path to obsidian CLI binary (empty = auto-detect) */
  binaryPath?: string;
  /** Command timeout in milliseconds */
  timeout: number;
  /** Vault name from app.vault.getName() */
  vaultName: string;
}

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Minimum Obsidian CLI version required for the commands we use */
const MIN_CLI_VERSION = [1, 12, 0] as const;

/**
 * Parse a semver-ish version string (e.g., "1.12.0", "v1.12.3-beta").
 * Returns [major, minor, patch] or null if unparseable.
 */
function parseVersion(raw: string): [number, number, number] | null {
  const match = raw.trim().match(/v?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [
    parseInt(match[1], 10),
    parseInt(match[2], 10),
    parseInt(match[3] ?? '0', 10),
  ];
}

/**
 * Returns true if `version` >= `minimum`.
 */
function meetsMinVersion(
  version: [number, number, number],
  minimum: readonly [number, number, number]
): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] > minimum[i]) return true;
    if (version[i] < minimum[i]) return false;
  }
  return true; // equal
}

/**
 * Known locations for the Obsidian CLI binary.
 * The CLI ships with Obsidian v1.12+ (early access).
 */
function getDefaultBinaryPaths(): string[] {
  const os = platform();
  if (os === 'darwin') {
    return [
      '/Applications/Obsidian.app/Contents/MacOS/Obsidian',
      '/usr/local/bin/obsidian',
    ];
  }
  if (os === 'linux') {
    return [
      '/usr/local/bin/obsidian',
      '/usr/bin/obsidian',
    ];
  }
  // Windows — not supported for CLI bridge currently
  return [];
}

/** Allowed CLI commands — rejects anything not on this list */
const ALLOWED_COMMANDS = new Set([
  'version',
  'sync:status',
  'sync:history',
  'sync:read',
  'sync:restore',
  'diff',
  'history',
  'history:read',
]);

/** Allowed parameter keys — rejects unknown keys to prevent argument injection */
const ALLOWED_PARAM_KEYS = new Set([
  'path',
  'version',
  'from',
  'to',
]);

/**
 * Validate a parameter value. Rejects values that could be interpreted
 * as CLI flags or contain control characters.
 */
function validateParamValue(key: string, value: string): void {
  if (value.startsWith('-')) {
    throw new Error(`Invalid parameter value for '${key}': must not start with '-'`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error(`Invalid parameter value for '${key}': contains control characters`);
  }
  if (value.length > 1024) {
    throw new Error(`Invalid parameter value for '${key}': exceeds maximum length (1024)`);
  }
}

/**
 * Low-level wrapper around the Obsidian CLI binary.
 *
 * Uses `child_process.execFile` (NOT `exec`) to avoid shell interpolation —
 * all arguments are passed as an array, preventing command injection.
 *
 * Security layers: command allowlist, parameter key allowlist, value validation.
 * Every command gets `vault=<name>` prepended automatically.
 */
export class CLIExecutor {
  private config: CLIExecutorConfig;
  private resolvedBinaryPath: string | null = null;
  private _isAvailable = false;

  constructor(config: CLIExecutorConfig) {
    this.config = config;
  }

  /**
   * Detect the CLI binary and validate with `obsidian version`.
   * Returns true if the CLI is usable.
   */
  async initialize(): Promise<boolean> {
    log.info('Initializing CLI executor', { vaultName: this.config.vaultName });

    this.resolvedBinaryPath = this.resolveBinaryPath();
    if (!this.resolvedBinaryPath) {
      log.warn('Obsidian CLI binary not found');
      this._isAvailable = false;
      return false;
    }

    try {
      const result = await this.executeRaw(['version']);
      if (result.exitCode !== 0) {
        log.warn('Obsidian CLI version check failed', { stderr: result.stderr, exitCode: result.exitCode });
        this._isAvailable = false;
        return false;
      }

      const versionStr = result.stdout.trim();
      const parsed = parseVersion(versionStr);
      if (!parsed) {
        log.warn('Could not parse Obsidian CLI version', { raw: versionStr });
        this._isAvailable = false;
        return false;
      }

      if (!meetsMinVersion(parsed, MIN_CLI_VERSION)) {
        log.warn('Obsidian CLI version too old for CLI bridge', {
          detected: versionStr,
          minimum: MIN_CLI_VERSION.join('.'),
        });
        this._isAvailable = false;
        return false;
      }

      log.info('Obsidian CLI available', { path: this.resolvedBinaryPath, version: versionStr });
      this._isAvailable = true;
      return true;
    } catch (error) {
      log.warn('Obsidian CLI validation failed', { error: error instanceof Error ? error.message : String(error) });
      this._isAvailable = false;
      return false;
    }
  }

  get isAvailable(): boolean {
    return this._isAvailable;
  }

  async execute(
    command: string,
    params?: Record<string, string>,
    flags?: string[]
  ): Promise<CLIResult> {
    if (!this._isAvailable || !this.resolvedBinaryPath) {
      throw new Error('CLI executor not initialized or unavailable');
    }

    if (!ALLOWED_COMMANDS.has(command)) {
      throw new Error(`Blocked CLI command: '${command}' is not in the allowed command list`);
    }

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (!ALLOWED_PARAM_KEYS.has(key)) {
          throw new Error(`Blocked CLI parameter key: '${key}' is not in the allowed parameter list`);
        }
        validateParamValue(key, value);
      }
    }

    const args: string[] = [`vault=${this.config.vaultName}`, command];
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        args.push(`${key}=${value}`);
      }
    }
    if (flags) {
      args.push(...flags);
    }

    log.debug('Executing CLI command', { command, args });
    return this.executeRaw(args);
  }

  async executeJson<T>(command: string, params?: Record<string, string>): Promise<T> {
    const result = await this.execute(command, params);
    if (result.exitCode !== 0) {
      throw new Error(`CLI command '${command}' failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
    }
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new Error(`CLI command '${command}' returned non-JSON output: ${result.stdout.slice(0, 200)}`);
    }
  }

  /**
   * Execute raw args against the CLI binary.
   * Uses execFile — args passed as array, no shell, no injection risk.
   */
  private executeRaw(args: string[]): Promise<CLIResult> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, PATH: getEnhancedPath() };

      // execFile does NOT spawn a shell — arguments cannot be interpreted as shell metacharacters
      execFile(
        this.resolvedBinaryPath!,
        args,
        { timeout: this.config.timeout, env, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && !('code' in error)) {
            reject(error);
            return;
          }
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode: error
              ? (typeof (error as { code?: unknown }).code === 'number'
                ? (error as { code: number }).code
                : 1)
              : 0,
          });
        }
      );
    });
  }

  private resolveBinaryPath(): string | null {
    if (this.config.binaryPath && existsSync(this.config.binaryPath)) {
      log.debug('Using configured binary path', { path: this.config.binaryPath });
      return this.config.binaryPath;
    }
    for (const path of getDefaultBinaryPaths()) {
      if (existsSync(path)) {
        log.debug('Found binary at default path', { path });
        return path;
      }
    }
    log.debug('Falling back to PATH resolution for obsidian binary');
    return 'obsidian';
  }
}
