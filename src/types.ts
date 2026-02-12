import type { ElicitationContent, ElicitResult } from '@modelcontextprotocol/sdk/types.js';

export type MCPTransportType = 'stdio' | 'http' | 'sse' | 'both';

/**
 * Tool definition — the universal contract between tool providers and the MCP server.
 *
 * Both obsidi-mcp and obsidi-claude define this interface independently.
 * TypeScript structural typing means they're compatible at runtime without a shared package.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (params: Record<string, unknown>, context?: ToolExecutionContext) => Promise<string>;
}

/**
 * Execution context threaded through tool handlers.
 * Carries MCP capabilities like elicitation without coupling tools to MCP types.
 */
export interface ToolExecutionContext {
  elicitInput?: (params: { mode: string; message: string; requestedSchema: ElicitationContent }) => Promise<ElicitResult>;
}

/**
 * A tool provider registers a set of tools with the MCP server.
 * Any Obsidian plugin can implement this to expose tools via MCP.
 */
export interface ToolProvider {
  /** Unique provider ID (plugin ID recommended, e.g., 'obsidi-claude') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Tool definitions provided by this plugin */
  tools: ToolDefinition[];
}

export interface CLIBridgeSettings {
  /** Enable CLI bridge to expose Obsidian CLI tools (desktop only) */
  enabled: boolean;
  /** Path to obsidian CLI binary (empty = auto-detect) */
  binaryPath: string;
  /** Command timeout in milliseconds */
  timeout: number;
}

export const DEFAULT_CLI_BRIDGE_SETTINGS: CLIBridgeSettings = {
  enabled: false,
  binaryPath: '',
  timeout: 10000,
};

export interface ObsidianMCPSettings {
  enabled: boolean;
  serverName: string;
  transport: MCPTransportType;
  httpPort: number;
  cliBridge: CLIBridgeSettings;
}

export const DEFAULT_SETTINGS: ObsidianMCPSettings = {
  enabled: false,
  serverName: 'obsidi-mcp',
  transport: 'http',
  httpPort: 3000,
  cliBridge: DEFAULT_CLI_BRIDGE_SETTINGS,
};

export interface MCPServerConfig {
  name: string;
  version: string;
  transport: MCPTransportType;
  httpPort: number;
  /** Session idle timeout in milliseconds (default: 30 minutes) */
  sessionTimeoutMs?: number;
  /** How often to check for expired sessions in milliseconds (default: 5 minutes) */
  cleanupIntervalMs?: number;
  /** Maximum concurrent sessions (default: 100) */
  maxSessions?: number;
  /** Callbacks for session persistence (enables hot reload recovery) */
  sessionPersistence?: {
    loadStaleSessionIds: () => Set<string>;
    saveSessionIds: (sessionIds: string[]) => void;
    clearSessionIds: () => void;
  };
}
