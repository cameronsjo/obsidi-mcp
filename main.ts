import { Plugin } from 'obsidian';
import type { ToolDefinition, ToolProvider, ObsidianMCPSettings, MCPServerConfig } from './src/types';
import { DEFAULT_SETTINGS } from './src/types';
import { MCPServer } from './src/mcpServer';
import { VaultResources } from './src/vaultResources';
import { ObsidianTools } from './src/obsidianTools';
import { CLIExecutor } from './src/cliBridge/cliExecutor';
import { CLITools } from './src/cliBridge/cliTools';
import { ObsidiMCPSettingsTab } from './src/settingsTab';
import { createLogger } from './src/logger';

const log = createLogger('ObsidiMCP');

interface PersistedData {
  settings: ObsidianMCPSettings;
  sessionIds?: string[];
}

/**
 * Obsidi MCP — standalone MCP server plugin for Obsidian.
 *
 * Exposes vault tools via Model Context Protocol (stdio/HTTP/SSE).
 * Ships with built-in ObsidianTools (28 vault tools) and CLI bridge (7 tools).
 * Other plugins (e.g., obsidi-claude) can register additional tool providers.
 */
export default class ObsidiMCPPlugin extends Plugin {
  settings: ObsidianMCPSettings = DEFAULT_SETTINGS;
  private mcpServer: MCPServer | null = null;
  private vaultResources: VaultResources | null = null;
  private obsidianTools: ObsidianTools | null = null;
  private cliExecutor: CLIExecutor | null = null;
  private cliTools: CLITools | null = null;
  private toolProviders: Map<string, ToolProvider> = new Map();

  // ── Public API for other plugins ──

  /**
   * Register a tool provider. Triggers tools/list_changed on all connected MCP clients.
   */
  registerToolProvider(provider: ToolProvider): void {
    log.info('Tool provider registered', { id: provider.id, name: provider.name, toolCount: provider.tools.length });
    this.toolProviders.set(provider.id, provider);
    this.mcpServer?.notifyToolsChanged();
  }

  /**
   * Unregister a tool provider by ID. Triggers tools/list_changed on all connected MCP clients.
   */
  unregisterToolProvider(id: string): void {
    if (this.toolProviders.delete(id)) {
      log.info('Tool provider unregistered', { id });
      this.mcpServer?.notifyToolsChanged();
    }
  }

  /**
   * Check if the MCP server is currently running.
   */
  isServerRunning(): boolean {
    return this.mcpServer?.isServerRunning() ?? false;
  }

  // ── Internal ──

  /**
   * Build the complete tool list from all sources.
   * Priority (last wins for duplicate names): built-in → CLI bridge → external providers
   */
  getAllToolDefinitions(): ToolDefinition[] {
    const toolMap = new Map<string, ToolDefinition>();

    // Layer 1: Built-in ObsidianTools
    if (this.obsidianTools) {
      for (const tool of this.obsidianTools.getToolDefinitions()) {
        toolMap.set(tool.name, tool);
      }
    }

    // Layer 2: CLI bridge tools
    if (this.cliTools) {
      for (const tool of this.cliTools.getToolDefinitions()) {
        toolMap.set(tool.name, tool);
      }
    }

    // Layer 3: External providers (e.g., obsidi-claude with RAG-enhanced tools)
    for (const provider of this.toolProviders.values()) {
      for (const tool of provider.tools) {
        toolMap.set(tool.name, tool);
      }
    }

    return Array.from(toolMap.values());
  }

  async onload(): Promise<void> {
    log.info('Loading Obsidi MCP plugin');

    // Load settings
    const data = (await this.loadData()) as PersistedData | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };

    // Initialize vault resources (direct app.vault access for MCP resource operations)
    this.vaultResources = new VaultResources(this.app);

    // Initialize built-in ObsidianTools
    this.obsidianTools = new ObsidianTools(this.app);

    // Add settings tab
    this.addSettingTab(new ObsidiMCPSettingsTab(this.app, this));

    // Register commands
    this.addCommand({
      id: 'toggle-mcp-server',
      name: 'Toggle MCP server',
      callback: async () => {
        if (this.mcpServer?.isServerRunning()) {
          await this.stopMCPServer();
        } else {
          await this.startMCPServer();
        }
      },
    });

    this.addCommand({
      id: 'start-mcp-server',
      name: 'Start MCP server',
      callback: async () => {
        await this.startMCPServer();
      },
    });

    this.addCommand({
      id: 'stop-mcp-server',
      name: 'Stop MCP server',
      callback: async () => {
        await this.stopMCPServer();
      },
    });

    // Auto-start on layout ready
    this.app.workspace.onLayoutReady(async () => {
      await this.initializeCLIBridge();

      if (this.settings.enabled) {
        await this.startMCPServer();
      }
    });
  }

  async onunload(): Promise<void> {
    log.info('Unloading Obsidi MCP plugin');
    await this.stopMCPServer();
  }

  async saveSettings(): Promise<void> {
    const data: PersistedData = { settings: this.settings };
    await this.saveData(data);
  }

  private async initializeCLIBridge(): Promise<void> {
    if (!this.settings.cliBridge.enabled) {
      log.debug('CLI bridge disabled in settings');
      return;
    }

    try {
      this.cliExecutor = new CLIExecutor({
        binaryPath: this.settings.cliBridge.binaryPath || undefined,
        timeout: this.settings.cliBridge.timeout,
        vaultName: this.app.vault.getName(),
      });

      const available = await this.cliExecutor.initialize();
      if (available) {
        this.cliTools = new CLITools(this.cliExecutor);
        log.info('CLI bridge initialized', { toolCount: this.cliTools.getToolDefinitions().length });
      } else {
        log.info('CLI bridge not available (Obsidian CLI not found or version too old)');
        this.cliExecutor = null;
      }
    } catch (error) {
      log.warn('CLI bridge initialization failed', { error: error instanceof Error ? error.message : String(error) });
      this.cliExecutor = null;
    }
  }

  private async startMCPServer(): Promise<void> {
    if (this.mcpServer?.isServerRunning()) {
      log.warn('MCP server already running');
      return;
    }

    if (!this.vaultResources) {
      log.error('Cannot start MCP server: VaultResources not initialized');
      return;
    }

    // Load persisted session IDs for hot reload recovery
    const persistedData = (await this.loadData()) as PersistedData | null;
    const staleSessionIds = new Set(persistedData?.sessionIds ?? []);

    const config: MCPServerConfig = {
      name: this.settings.serverName,
      version: this.manifest.version,
      transport: this.settings.transport,
      httpPort: this.settings.httpPort,
      sessionPersistence: {
        loadStaleSessionIds: () => staleSessionIds,
        saveSessionIds: async (ids: string[]) => {
          const current = (await this.loadData()) as PersistedData | null;
          await this.saveData({ ...current, sessionIds: ids });
        },
        clearSessionIds: async () => {
          const current = (await this.loadData()) as PersistedData | null;
          await this.saveData({ ...current, sessionIds: [] });
        },
      },
    };

    this.mcpServer = new MCPServer(
      this.vaultResources,
      () => this.getAllToolDefinitions(),
      config
    );

    try {
      await this.mcpServer.start();
      log.info('MCP server started', {
        transport: this.settings.transport,
        toolCount: this.getAllToolDefinitions().length,
      });
    } catch (error) {
      log.error('Failed to start MCP server', error);
      this.mcpServer = null;
    }
  }

  private async stopMCPServer(): Promise<void> {
    if (!this.mcpServer) return;

    try {
      await this.mcpServer.stop();
      log.info('MCP server stopped');
    } catch (error) {
      log.error('Error stopping MCP server', error);
    } finally {
      this.mcpServer = null;
    }
  }
}
