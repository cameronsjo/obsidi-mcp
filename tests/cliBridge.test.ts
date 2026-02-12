import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before imports (mocking execFile, the safe variant)
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock('os', () => ({
  platform: vi.fn(() => 'darwin'),
  homedir: vi.fn(() => '/Users/test'),
}));

vi.mock('../src/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../src/claudePath', () => ({
  getEnhancedPath: vi.fn(() => '/usr/local/bin:/usr/bin'),
}));

// NOTE: We import execFile here only to mock it — the actual code under test
// uses execFile (NOT exec) deliberately for injection safety.
import { execFile } from 'child_process';
import { CLIExecutor } from '../src/cliBridge/cliExecutor';
import { CLITools } from '../src/cliBridge/cliTools';

const mockExecFile = vi.mocked(execFile);

/**
 * Helper to make the mocked execFile resolve with given stdout/stderr.
 */
function mockExecFileResult(stdout: string, stderr = '', exitCode = 0): void {
  mockExecFile.mockImplementation(
    (_file: string, _args: readonly string[] | undefined | null, _options: unknown, callback: unknown) => {
      const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
      if (exitCode !== 0) {
        const error = new Error('Command failed') as Error & { code: number };
        error.code = exitCode;
        cb(error, stdout, stderr);
      } else {
        cb(null, stdout, stderr);
      }
      return {} as ReturnType<typeof execFile>;
    }
  );
}

describe('CLIExecutor', () => {
  let executor: CLIExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new CLIExecutor({
      vaultName: 'TestVault',
      timeout: 5000,
    });
  });

  describe('initialize', () => {
    it('should initialize successfully when CLI returns version', async () => {
      mockExecFileResult('1.12.0\n');
      const result = await executor.initialize();
      expect(result).toBe(true);
      expect(executor.isAvailable).toBe(true);
    });

    it('should accept version with v prefix', async () => {
      mockExecFileResult('v1.13.2\n');
      const result = await executor.initialize();
      expect(result).toBe(true);
    });

    it('should reject version below minimum (1.12.0)', async () => {
      mockExecFileResult('1.11.9\n');
      const result = await executor.initialize();
      expect(result).toBe(false);
      expect(executor.isAvailable).toBe(false);
    });

    it('should accept exact minimum version', async () => {
      mockExecFileResult('1.12.0\n');
      const result = await executor.initialize();
      expect(result).toBe(true);
    });

    it('should reject unparseable version string', async () => {
      mockExecFileResult('not-a-version\n');
      const result = await executor.initialize();
      expect(result).toBe(false);
    });

    it('should fail gracefully when CLI version check fails', async () => {
      mockExecFileResult('', 'not found', 127);
      const result = await executor.initialize();
      expect(result).toBe(false);
      expect(executor.isAvailable).toBe(false);
    });
  });

  describe('execute', () => {
    beforeEach(async () => {
      mockExecFileResult('1.12.0\n');
      await executor.initialize();
      vi.clearAllMocks();
    });

    it('should build args correctly with vault name prepended', async () => {
      mockExecFileResult('{"connected": true}');
      await executor.execute('sync:status');

      expect(mockExecFile).toHaveBeenCalledWith(
        expect.any(String),
        ['vault=TestVault', 'sync:status'],
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should include params as key=value pairs', async () => {
      mockExecFileResult('{"versions": []}');
      await executor.execute('sync:history', { path: 'notes/foo.md' });

      expect(mockExecFile).toHaveBeenCalledWith(
        expect.any(String),
        ['vault=TestVault', 'sync:history', 'path=notes/foo.md'],
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should include multiple params', async () => {
      mockExecFileResult('diff output');
      await executor.execute('diff', { path: 'notes/foo.md', from: '1', to: '3' });

      expect(mockExecFile).toHaveBeenCalledWith(
        expect.any(String),
        ['vault=TestVault', 'diff', 'path=notes/foo.md', 'from=1', 'to=3'],
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should reject disallowed commands', async () => {
      await expect(executor.execute('eval')).rejects.toThrow('Blocked CLI command');
    });

    it('should reject disallowed parameter keys', async () => {
      await expect(
        executor.execute('sync:status', { malicious: 'value' })
      ).rejects.toThrow('Blocked CLI parameter key');
    });

    it('should reject values starting with dash', async () => {
      await expect(
        executor.execute('sync:history', { path: '--evil-flag' })
      ).rejects.toThrow('must not start with');
    });

    it('should reject values with control characters', async () => {
      await expect(
        executor.execute('sync:history', { path: 'foo\x00bar' })
      ).rejects.toThrow('contains control characters');
    });

    it('should reject overlong values', async () => {
      const longValue = 'a'.repeat(1025);
      await expect(
        executor.execute('sync:history', { path: longValue })
      ).rejects.toThrow('exceeds maximum length');
    });

    it('should throw when not initialized', async () => {
      const uninitExecutor = new CLIExecutor({ vaultName: 'Test', timeout: 5000 });
      await expect(uninitExecutor.execute('sync:status')).rejects.toThrow(
        'not initialized'
      );
    });
  });

  describe('executeJson', () => {
    beforeEach(async () => {
      mockExecFileResult('1.12.0\n');
      await executor.initialize();
      vi.clearAllMocks();
    });

    it('should parse JSON output', async () => {
      mockExecFileResult('{"connected": true, "lastSync": 1234567890}');
      const result = await executor.executeJson<{ connected: boolean }>('sync:status');
      expect(result).toEqual({ connected: true, lastSync: 1234567890 });
    });

    it('should throw on non-JSON output', async () => {
      mockExecFileResult('not json');
      await expect(executor.executeJson('sync:status')).rejects.toThrow('non-JSON');
    });

    it('should throw on non-zero exit code', async () => {
      mockExecFileResult('', 'error message', 1);
      await expect(executor.executeJson('sync:status')).rejects.toThrow('failed');
    });
  });
});

describe('CLITools', () => {
  let tools: CLITools;
  let mockExecutor: CLIExecutor;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExecutor = new CLIExecutor({ vaultName: 'TestVault', timeout: 5000 });
    mockExecFileResult('1.12.0\n');
    await mockExecutor.initialize();
    vi.clearAllMocks();

    tools = new CLITools(mockExecutor);
  });

  describe('getToolDefinitions', () => {
    it('should return 7 tool definitions', () => {
      const defs = tools.getToolDefinitions();
      expect(defs).toHaveLength(7);
    });

    it('should have expected tool names', () => {
      const names = tools.getToolDefinitions().map((t) => t.name);
      expect(names).toEqual([
        'sync_status',
        'sync_history',
        'sync_read',
        'sync_restore',
        'file_diff',
        'file_history',
        'file_history_read',
      ]);
    });

    it('should have descriptions for all tools', () => {
      for (const tool of tools.getToolDefinitions()) {
        expect(tool.description).toBeTruthy();
        expect(tool.description.length).toBeGreaterThan(10);
      }
    });

    it('should have parameter schemas for all tools', () => {
      for (const tool of tools.getToolDefinitions()) {
        expect(tool.parameters).toHaveProperty('type', 'object');
      }
    });
  });

  describe('getToolSchemas', () => {
    it('should return schemas in MCP format', () => {
      const schemas = tools.getToolSchemas();
      expect(schemas).toHaveLength(7);
      for (const schema of schemas) {
        expect(schema).toHaveProperty('name');
        expect(schema).toHaveProperty('description');
        expect(schema).toHaveProperty('input_schema');
      }
    });
  });

  describe('executeTool', () => {
    it('should execute sync_status', async () => {
      mockExecFileResult('{"connected": true}');
      const result = await tools.executeTool('sync_status', {});
      const parsed = JSON.parse(result);
      expect(parsed).toEqual({ connected: true });
    });

    it('should execute sync_history with path', async () => {
      mockExecFileResult('{"versions": [1, 2, 3]}');
      const result = await tools.executeTool('sync_history', { path: 'test.md' });
      const parsed = JSON.parse(result);
      expect(parsed).toEqual({ versions: [1, 2, 3] });
    });

    it('should execute sync_read with path and version', async () => {
      mockExecFileResult('# Hello World');
      const result = await tools.executeTool('sync_read', { path: 'test.md', version: 2 });
      const parsed = JSON.parse(result);
      expect(parsed.content).toBe('# Hello World');
      expect(parsed.version).toBe(2);
    });

    it('should execute file_diff with from/to', async () => {
      mockExecFileResult('--- a/test.md\n+++ b/test.md\n@@ -1 +1 @@\n-old\n+new');
      const result = await tools.executeTool('file_diff', { path: 'test.md', from: 1, to: 3 });
      const parsed = JSON.parse(result);
      expect(parsed.diff).toContain('-old');
      expect(parsed.diff).toContain('+new');
    });

    it('should throw for unknown tool', async () => {
      await expect(tools.executeTool('nonexistent', {})).rejects.toThrow('Unknown CLI tool');
    });

    it('should return error JSON on CLI failure', async () => {
      mockExecFileResult('', 'Sync not configured', 1);
      const result = await tools.executeTool('sync_status', {});
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeTruthy();
    });

    it('should handle sync_restore with elicitation context', async () => {
      mockExecFileResult('Restored successfully');
      const context = {
        elicitInput: vi.fn().mockResolvedValue({
          action: 'accept',
          content: { confirm: true },
        }),
      };
      const result = await tools.executeTool(
        'sync_restore',
        { path: 'test.md', version: 2 },
        context
      );
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(context.elicitInput).toHaveBeenCalledOnce();
    });

    it('should cancel sync_restore when user declines', async () => {
      const context = {
        elicitInput: vi.fn().mockResolvedValue({
          action: 'reject',
          content: {},
        }),
      };
      const result = await tools.executeTool(
        'sync_restore',
        { path: 'test.md', version: 2 },
        context
      );
      const parsed = JSON.parse(result);
      expect(parsed.cancelled).toBe(true);
    });
  });
});
