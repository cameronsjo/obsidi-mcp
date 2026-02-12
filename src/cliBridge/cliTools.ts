import type { ToolDefinition, ToolExecutionContext } from '../types';
import type { CLIExecutor } from './cliExecutor';
import { createLogger } from '../logger';

const log = createLogger('CLITools');

/**
 * Wraps an async handler with error handling and JSON serialization.
 * Same pattern as ObsidianTools.wrapHandler (obsidianTools.ts:67).
 */
function wrapHandler<T>(
  fn: (params: Record<string, unknown>, context?: ToolExecutionContext) => Promise<T>
): (params: Record<string, unknown>, context?: ToolExecutionContext) => Promise<string> {
  return async (params, context) => {
    try {
      const result = await fn(params, context);
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/**
 * CLI-backed tool definitions for capabilities not available through the plugin API.
 *
 * Exposes Obsidian Sync history, file recovery, and diff via the Obsidian CLI (v1.12+).
 * Desktop-only — mobile has no CLI.
 */
export class CLITools {
  private executor: CLIExecutor;
  private tools: ToolDefinition[];

  constructor(executor: CLIExecutor) {
    this.executor = executor;
    this.tools = [
      this.getSyncStatusTool(),
      this.getSyncHistoryTool(),
      this.getSyncReadTool(),
      this.getSyncRestoreTool(),
      this.getFileDiffTool(),
      this.getFileHistoryTool(),
      this.getFileHistoryReadTool(),
    ];
    log.info('CLI tools initialized', { toolCount: this.tools.length });
  }

  /** Get all CLI tool definitions */
  getToolDefinitions(): ToolDefinition[] {
    return this.tools;
  }

  /** Get tool schemas in MCP listing format */
  getToolSchemas(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  /** Execute a CLI tool by name */
  async executeTool(
    name: string,
    params: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<string> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`Unknown CLI tool: ${name}`);
    }
    return tool.handler(params, context);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Sync Tools
  // ─────────────────────────────────────────────────────────────────────────

  private getSyncStatusTool(): ToolDefinition {
    return {
      name: 'sync_status',
      description:
        'Get Obsidian Sync connection status including sync state, last sync time, and usage. ' +
        'Returns error if Sync is not configured for this vault.',
      parameters: {
        type: 'object',
        properties: {},
      },
      handler: wrapHandler(async () => {
        const result = await this.executor.execute('sync:status');
        if (result.exitCode !== 0) {
          return { error: `Sync status failed: ${result.stderr || result.stdout}` };
        }
        // Try to parse as JSON; fall back to raw text
        try {
          return JSON.parse(result.stdout);
        } catch {
          return { status: result.stdout.trim() };
        }
      }),
    };
  }

  private getSyncHistoryTool(): ToolDefinition {
    return {
      name: 'sync_history',
      description:
        'Get the sync version history for a specific file. Returns a list of versions ' +
        'with timestamps, allowing you to browse and restore previous sync versions.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault path to the file (e.g., "notes/foo.md")' },
        },
        required: ['path'],
      },
      handler: wrapHandler(async (params) => {
        const path = params.path as string;
        const result = await this.executor.execute('sync:history', { path });
        if (result.exitCode !== 0) {
          return { error: `Sync history failed: ${result.stderr || result.stdout}`, path };
        }
        try {
          return JSON.parse(result.stdout);
        } catch {
          return { history: result.stdout.trim(), path };
        }
      }),
    };
  }

  private getSyncReadTool(): ToolDefinition {
    return {
      name: 'sync_read',
      description:
        'Read the content of a specific sync version of a file. Use sync_history first ' +
        'to find available version numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault path to the file' },
          version: { type: 'number', description: 'Version number to read' },
        },
        required: ['path', 'version'],
      },
      handler: wrapHandler(async (params) => {
        const path = params.path as string;
        const version = String(params.version);
        const result = await this.executor.execute('sync:read', { path, version });
        if (result.exitCode !== 0) {
          return { error: `Sync read failed: ${result.stderr || result.stdout}`, path, version };
        }
        return { path, version: Number(version), content: result.stdout };
      }),
    };
  }

  private getSyncRestoreTool(): ToolDefinition {
    return {
      name: 'sync_restore',
      description:
        'Restore a file to a specific sync version. This overwrites the current file content. ' +
        'Requires user confirmation before proceeding.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault path to the file' },
          version: { type: 'number', description: 'Version number to restore' },
        },
        required: ['path', 'version'],
      },
      handler: wrapHandler(async (params, context) => {
        const path = params.path as string;
        const version = String(params.version);

        // Elicit confirmation (same pattern as delete tool)
        if (context?.elicitInput) {
          const confirmation = await context.elicitInput({
            mode: 'form',
            message: `Confirm restore of "${path}" to sync version ${version}. This will overwrite the current file content.`,
            requestedSchema: {
              type: 'object',
              properties: {
                confirm: {
                  type: 'boolean',
                  title: 'Confirm restore',
                  description: `Restore ${path} to version ${version}`,
                },
              },
              required: ['confirm'],
            },
          });

          if (confirmation.action !== 'accept' || !confirmation.content?.confirm) {
            return { cancelled: true, path, version: Number(version), message: 'Restore cancelled by user' };
          }
        }

        const result = await this.executor.execute('sync:restore', { path, version });
        if (result.exitCode !== 0) {
          return { error: `Sync restore failed: ${result.stderr || result.stdout}`, path, version };
        }
        return { success: true, path, version: Number(version), message: result.stdout.trim() || 'Restored' };
      }),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Diff & File History Tools
  // ─────────────────────────────────────────────────────────────────────────

  private getFileDiffTool(): ToolDefinition {
    return {
      name: 'file_diff',
      description:
        'Compare two versions of a file and return a unified diff. Works with both ' +
        'sync versions and local file history versions.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault path to the file' },
          from: { type: 'number', description: 'Source version number' },
          to: { type: 'number', description: 'Target version number' },
        },
        required: ['path', 'from', 'to'],
      },
      handler: wrapHandler(async (params) => {
        const path = params.path as string;
        const from = String(params.from);
        const to = String(params.to);
        const result = await this.executor.execute('diff', { path, from, to });
        if (result.exitCode !== 0) {
          return { error: `Diff failed: ${result.stderr || result.stdout}`, path, from, to };
        }
        return { path, from: Number(from), to: Number(to), diff: result.stdout };
      }),
    };
  }

  private getFileHistoryTool(): ToolDefinition {
    return {
      name: 'file_history',
      description:
        'Get the local file recovery history for a file. Shows versions saved locally ' +
        'by Obsidian\'s file recovery feature (separate from Sync history).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault path to the file' },
        },
        required: ['path'],
      },
      handler: wrapHandler(async (params) => {
        const path = params.path as string;
        const result = await this.executor.execute('history', { path });
        if (result.exitCode !== 0) {
          return { error: `File history failed: ${result.stderr || result.stdout}`, path };
        }
        try {
          return JSON.parse(result.stdout);
        } catch {
          return { history: result.stdout.trim(), path };
        }
      }),
    };
  }

  private getFileHistoryReadTool(): ToolDefinition {
    return {
      name: 'file_history_read',
      description:
        'Read the content of a specific local file recovery version. Use file_history first ' +
        'to find available version numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault path to the file' },
          version: { type: 'number', description: 'Version number to read' },
        },
        required: ['path', 'version'],
      },
      handler: wrapHandler(async (params) => {
        const path = params.path as string;
        const version = String(params.version);
        const result = await this.executor.execute('history:read', { path, version });
        if (result.exitCode !== 0) {
          return { error: `History read failed: ${result.stderr || result.stdout}`, path, version };
        }
        return { path, version: Number(version), content: result.stdout };
      }),
    };
  }
}
