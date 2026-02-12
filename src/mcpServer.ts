import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  CompleteRequestSchema,
  RootsListChangedNotificationSchema,
  isInitializeRequest,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import express, { type Express, type Request, type Response } from 'express';
import type { Server as HttpServer } from 'http';
import type { ToolDefinition, ToolExecutionContext, MCPServerConfig } from './types';
import type { VaultResources } from './vaultResources';
import { createLogger, Logger, type LogEntry, type LogLevel } from './logger';

const log = createLogger('MCPServer');

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_SESSIONS = 100;

interface SessionTransport {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastActivityTime: number;
}

interface SSESession {
  transport: SSEServerTransport;
  server: Server;
}

/**
 * MCP Server that exposes Obsidian vault tools to external Claude instances.
 *
 * Adapted from obsidi-claude's MCPServer. Key differences:
 * - Constructor takes VaultResources + getToolDefinitions callback (not ObsidianTools directly)
 * - Tool list is dynamic — rebuilt each time via callback (supports hot provider registration)
 * - notifyToolsChanged() sends tools/list_changed to all connected clients
 *
 * Supports stdio, HTTP (StreamableHTTP), and SSE transports.
 */
export class MCPServer {
  private stdioServer: Server | null = null;
  private stdioTransport: StdioServerTransport | null = null;
  private httpApp: Express | null = null;
  private httpServer: HttpServer | null = null;
  private httpSessions: Map<string, SessionTransport> = new Map();
  private staleSessionIds: Set<string> = new Set();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private sseApp: Express | null = null;
  private sseServer: HttpServer | null = null;
  private sseSessions: Map<string, SSESession> = new Map();
  private vaultResources: VaultResources;
  private getToolDefinitions: () => ToolDefinition[];
  private config: MCPServerConfig;
  private isRunning = false;
  private unsubscribeLogSink: (() => void) | null = null;
  private unsubscribeVaultChange: (() => void) | null = null;
  /** URIs subscribed by clients → set of Server instances watching them */
  private resourceSubscriptions: Map<string, Set<Server>> = new Map();

  /** Map our log levels to MCP RFC 5424 levels */
  private static readonly LOG_LEVEL_MAP: Record<LogLevel, string> = {
    debug: 'debug',
    info: 'info',
    warn: 'warning',
    error: 'error',
  };

  constructor(
    vaultResources: VaultResources,
    getToolDefinitions: () => ToolDefinition[],
    config: MCPServerConfig
  ) {
    this.vaultResources = vaultResources;
    this.getToolDefinitions = getToolDefinitions;
    this.config = config;
  }

  /**
   * Start the MCP server with configured transport(s)
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      log.warn('MCP server already running');
      return;
    }

    log.info('Starting MCP server', {
      name: this.config.name,
      version: this.config.version,
      transport: this.config.transport,
    });

    try {
      if (this.config.transport === 'stdio' || this.config.transport === 'both') {
        await this.startStdioServer();
      }

      if (this.config.transport === 'http' || this.config.transport === 'both') {
        await this.startHttpServer();
      }

      if (this.config.transport === 'sse') {
        await this.startSseServer();
      }

      // Register log sink to forward logs to connected MCP clients
      this.unsubscribeLogSink = Logger.addSink((entry: LogEntry) => {
        const mcpLevel = MCPServer.LOG_LEVEL_MAP[entry.level] ?? 'info';
        const data = {
          component: entry.component,
          action: entry.action,
          ...(entry.context ?? {}),
          ...(entry.error ? { error: entry.error.message } : {}),
        };

        for (const server of this.getActiveServers()) {
          server.sendLoggingMessage({ level: mcpLevel, logger: entry.component, data }).catch(() => {
            // Best-effort — don't break on send failures
          });
        }
      });

      // Wire vault change events to MCP resource notifications
      this.unsubscribeVaultChange = this.vaultResources.onVaultChange((event, path, oldPath) => {
        const uri = `vault://note/${path}`;

        // Notify subscribers of the changed resource
        const subscribers = this.resourceSubscriptions.get(uri);
        if (subscribers) {
          for (const server of subscribers) {
            server.sendResourceUpdated({ uri }).catch(() => {});
          }
        }

        // On rename, also notify subscribers of the old URI
        if (event === 'rename' && oldPath) {
          const oldUri = `vault://note/${oldPath}`;
          const oldSubscribers = this.resourceSubscriptions.get(oldUri);
          if (oldSubscribers) {
            for (const server of oldSubscribers) {
              server.sendResourceUpdated({ uri: oldUri }).catch(() => {});
            }
          }
        }

        // On create/delete/rename, the resource list changed
        if (event !== 'modify') {
          for (const server of this.getActiveServers()) {
            server.sendResourceListChanged().catch(() => {});
          }
        }
      });

      this.isRunning = true;
      log.info('MCP server started successfully');
    } catch (error) {
      log.error('Failed to start MCP server', error);
      await this.stop();
      throw error;
    }
  }

  /**
   * Notify all connected clients that the tool list has changed.
   * Called when a tool provider registers or unregisters.
   */
  notifyToolsChanged(): void {
    if (!this.isRunning) return;
    for (const server of this.getActiveServers()) {
      server.sendToolListChanged().catch(() => {});
    }
  }

  /**
   * Start the stdio transport server
   */
  private async startStdioServer(): Promise<void> {
    log.debug('Starting stdio transport');

    this.stdioServer = new Server(
      { name: this.config.name, version: this.config.version },
      { capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true }, completions: {}, elicitation: {}, logging: {} } }
    );

    this.setupServerHandlers(this.stdioServer);

    this.stdioTransport = new StdioServerTransport();
    await this.stdioServer.connect(this.stdioTransport);

    // Query client roots after connection (best-effort)
    this.logClientRoots(this.stdioServer).catch(() => {});

    log.info('Stdio transport started');
  }

  /**
   * Start the HTTP transport server
   */
  private async startHttpServer(): Promise<void> {
    log.debug('Starting HTTP transport', { port: this.config.httpPort });

    // Load stale session IDs from before last restart (enables hot reload recovery)
    if (this.config.sessionPersistence) {
      this.staleSessionIds = this.config.sessionPersistence.loadStaleSessionIds();
      if (this.staleSessionIds.size > 0) {
        log.info('Loaded stale session IDs for recovery', { count: this.staleSessionIds.size });
      }
    }

    this.httpApp = express();
    this.httpApp.use(express.json());

    // Health check endpoint
    this.httpApp.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        name: this.config.name,
        version: this.config.version,
        activeSessions: this.httpSessions.size,
      });
    });

    // MCP endpoint - handles POST, GET, DELETE for session management
    this.httpApp.post('/mcp', async (req: Request, res: Response) => {
      await this.handleMcpRequest(req, res);
    });

    this.httpApp.get('/mcp', async (req: Request, res: Response) => {
      await this.handleMcpRequest(req, res);
    });

    this.httpApp.delete('/mcp', async (req: Request, res: Response) => {
      await this.handleMcpRequest(req, res);
    });

    // Start listening
    await new Promise<void>((resolve, reject) => {
      try {
        this.httpServer = this.httpApp!.listen(this.config.httpPort, () => {
          log.info('HTTP transport started', {
            port: this.config.httpPort,
            url: `http://localhost:${this.config.httpPort}/mcp`,
          });
          resolve();
        });

        this.httpServer.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') {
            reject(new Error(`Port ${this.config.httpPort} is already in use`));
          } else {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });

    // Start session cleanup interval
    this.startCleanupInterval();
  }

  /**
   * Start the SSE transport server (deprecated but still supported)
   */
  private async startSseServer(): Promise<void> {
    log.debug('Starting SSE transport (deprecated)', { port: this.config.httpPort });

    this.sseApp = express();
    this.sseApp.use(express.json());

    // Health check endpoint
    this.sseApp.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        name: this.config.name,
        version: this.config.version,
        transport: 'sse',
        activeSessions: this.sseSessions.size,
      });
    });

    // SSE endpoint - client establishes connection here
    this.sseApp.get('/sse', async (req: Request, res: Response) => {
      log.info('SSE connection request received');

      const transport = new SSEServerTransport('/messages', res);
      const server = this.createMcpServer();

      await server.connect(transport);

      const sessionId = crypto.randomUUID();
      this.sseSessions.set(sessionId, { transport, server });

      log.info('SSE session established', { sessionId, activeSessions: this.sseSessions.size });
      this.logClientRoots(server).catch(() => {});

      // Clean up on connection close
      req.on('close', () => {
        this.sseSessions.delete(sessionId);
        log.info('SSE session closed', { sessionId, activeSessions: this.sseSessions.size });
      });
    });

    // Messages endpoint - client sends messages here
    this.sseApp.post('/messages', async (req: Request, res: Response) => {
      const sessionId = req.query.sessionId as string | undefined;

      if (!sessionId || !this.sseSessions.has(sessionId)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Invalid or missing session ID. Establish SSE connection first via GET /sse',
          },
          id: null,
        });
        return;
      }

      const session = this.sseSessions.get(sessionId)!;
      await session.transport.handlePostMessage(req, res, req.body);
    });

    // Start listening
    await new Promise<void>((resolve, reject) => {
      try {
        this.sseServer = this.sseApp!.listen(this.config.httpPort, () => {
          log.info('SSE transport started', {
            port: this.config.httpPort,
            sseUrl: `http://localhost:${this.config.httpPort}/sse`,
            messagesUrl: `http://localhost:${this.config.httpPort}/messages`,
          });
          resolve();
        });

        this.sseServer.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') {
            reject(new Error(`Port ${this.config.httpPort} is already in use`));
          } else {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle incoming MCP requests over HTTP
   */
  private async handleMcpRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      // Check for existing active session
      if (sessionId && this.httpSessions.has(sessionId)) {
        const session = this.httpSessions.get(sessionId)!;
        // Refresh activity time on each request
        session.lastActivityTime = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      // Check for stale session (existed before hot reload) - auto-recover
      if (sessionId && this.staleSessionIds.has(sessionId)) {
        log.info('Recovering stale session after hot reload', { sessionId });
        await this.recoverStaleSession(sessionId, req, res);
        return;
      }

      // New session - only allow if it's an initialize request
      if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
        await this.createNewSession(req, res);
        return;
      }

      // Invalid request
      const message = sessionId
        ? 'Invalid or expired session. Please reinitialize the MCP connection.'
        : 'Missing session ID or not an initialize request';
      log.warn('Invalid MCP request', { sessionId, hasSessionId: !!sessionId, method: req.method });
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message,
        },
        id: null,
      });
    } catch (error) {
      log.error('Error handling MCP request', error);
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
        },
        id: null,
      });
    }
  }

  /**
   * Create a new MCP session for an initialize request
   */
  private async createNewSession(req: Request, res: Response): Promise<void> {
    // Check max sessions limit
    const maxSessions = this.config.maxSessions ?? DEFAULT_MAX_SESSIONS;
    if (this.httpSessions.size >= maxSessions) {
      log.warn('Max sessions limit reached', { current: this.httpSessions.size, max: maxSessions });
      res.status(503).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Server is at maximum capacity. Please try again later.',
        },
        id: null,
      });
      return;
    }

    await this.createSessionWithTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      logMessage: 'HTTP session initialized',
      req,
      res,
    });
  }

  /**
   * Recover a stale session by creating a new transport with the same session ID
   */
  private async recoverStaleSession(sessionId: string, req: Request, res: Response): Promise<void> {
    this.staleSessionIds.delete(sessionId);

    await this.createSessionWithTransport({
      sessionIdGenerator: () => sessionId,
      logMessage: 'Stale session recovered',
      req,
      res,
    });
  }

  /**
   * Create a session with transport - shared logic for new and recovered sessions
   */
  private async createSessionWithTransport(options: {
    sessionIdGenerator: () => string;
    logMessage: string;
    req: Request;
    res: Response;
  }): Promise<void> {
    const { sessionIdGenerator, logMessage, req, res } = options;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator,
      onsessioninitialized: (id: string) => {
        const server = this.createMcpServer();
        this.httpSessions.set(id, { transport, server, lastActivityTime: Date.now() });
        log.info(logMessage, { sessionId: id, activeSessions: this.httpSessions.size });
        this.logClientRoots(server).catch(() => {});
      },
      onsessionclosed: (id: string) => {
        this.httpSessions.delete(id);
        log.info('HTTP session closed', { sessionId: id });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        this.httpSessions.delete(transport.sessionId);
      }
    };

    const server = this.createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /**
   * Create a new MCP server instance with handlers configured
   */
  private createMcpServer(): Server {
    const server = new Server(
      { name: this.config.name, version: this.config.version },
      { capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true }, completions: {}, elicitation: {}, logging: {} } }
    );
    this.setupServerHandlers(server);
    return server;
  }

  /**
   * Start the session cleanup interval
   */
  private startCleanupInterval(): void {
    const intervalMs = this.config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), intervalMs);
    log.debug('Session cleanup interval started', { intervalMs });
  }

  /**
   * Stop the session cleanup interval
   */
  private stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      log.debug('Session cleanup interval stopped');
    }
  }

  /**
   * Remove sessions that have been idle longer than the timeout
   */
  private cleanupExpiredSessions(): void {
    const timeoutMs = this.config.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    const now = Date.now();
    const expiredSessions: string[] = [];

    for (const [sessionId, session] of this.httpSessions) {
      const idleTime = now - session.lastActivityTime;
      if (idleTime > timeoutMs) {
        expiredSessions.push(sessionId);
      }
    }

    for (const sessionId of expiredSessions) {
      const session = this.httpSessions.get(sessionId);
      if (session) {
        try {
          session.server.close();
        } catch {
          // Ignore close errors
        }
        this.httpSessions.delete(sessionId);
        log.info('Expired session cleaned up', { sessionId, idleTimeMs: now - session.lastActivityTime });
      }
    }

    if (expiredSessions.length > 0) {
      log.debug('Session cleanup completed', { removed: expiredSessions.length, remaining: this.httpSessions.size });
    }
  }

  /** Collect all active Server instances for broadcasting (logging, notifications) */
  private getActiveServers(): Server[] {
    const servers: Server[] = [];
    if (this.stdioServer) servers.push(this.stdioServer);
    for (const session of this.httpSessions.values()) {
      servers.push(session.server);
    }
    for (const session of this.sseSessions.values()) {
      servers.push(session.server);
    }
    return servers;
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    log.info('Stopping MCP server');

    try {
      // Unsubscribe log sink and vault change listener before tearing down servers
      if (this.unsubscribeLogSink) {
        this.unsubscribeLogSink();
        this.unsubscribeLogSink = null;
      }
      if (this.unsubscribeVaultChange) {
        this.unsubscribeVaultChange();
        this.unsubscribeVaultChange = null;
      }
      this.resourceSubscriptions.clear();

      // Stop cleanup interval
      this.stopCleanupInterval();

      // Stop stdio server
      if (this.stdioServer) {
        await this.stdioServer.close();
        this.stdioServer = null;
        this.stdioTransport = null;
      }

      // Stop HTTP server and close all sessions
      if (this.httpServer) {
        // Save session IDs before clearing (enables hot reload recovery)
        if (this.config.sessionPersistence && this.httpSessions.size > 0) {
          const sessionIds = Array.from(this.httpSessions.keys());
          this.config.sessionPersistence.saveSessionIds(sessionIds);
          log.info('Saved session IDs for hot reload recovery', { count: sessionIds.length });
        }

        // Close all active sessions
        for (const [sessionId, session] of this.httpSessions) {
          try {
            await session.server.close();
          } catch {
            log.debug('Error closing session', { sessionId });
          }
        }
        this.httpSessions.clear();

        await new Promise<void>((resolve) => {
          this.httpServer!.close(() => resolve());
        });
        this.httpServer = null;
        this.httpApp = null;
      }

      // Stop SSE server and close all sessions
      if (this.sseServer) {
        for (const [sessionId, session] of this.sseSessions) {
          try {
            await session.server.close();
          } catch {
            log.debug('Error closing SSE session', { sessionId });
          }
        }
        this.sseSessions.clear();

        await new Promise<void>((resolve) => {
          this.sseServer!.close(() => resolve());
        });
        this.sseServer = null;
        this.sseApp = null;
      }

      this.isRunning = false;
      log.info('MCP server stopped');
    } catch (error) {
      log.error('Error stopping MCP server', error);
      throw error;
    }
  }

  /**
   * Check if the server is running
   */
  isServerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get current server status
   */
  getStatus(): { running: boolean; transport: string; httpPort?: number; activeSessions?: number } {
    return {
      running: this.isRunning,
      transport: this.config.transport,
      httpPort: this.config.transport !== 'stdio' ? this.config.httpPort : undefined,
      activeSessions: this.httpSessions.size + this.sseSessions.size,
    };
  }

  /**
   * Setup request handlers for a server instance
   */
  private setupServerHandlers(server: Server): void {
    // Handle tool listing — calls getToolDefinitions() callback each time (dynamic)
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const toolDefs = this.getToolDefinitions();
      log.debug('Listing tools', { count: toolDefs.length });

      return {
        tools: toolDefs.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        })),
      };
    });

    // Handle tool calls — dispatches to the matching ToolDefinition handler directly
    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      log.info('Tool call received', { tool: name });

      const toolDefs = this.getToolDefinitions();
      const toolDef = toolDefs.find((t) => t.name === name);
      if (!toolDef) {
        log.warn('Unknown tool requested', { tool: name });
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
          isError: true,
        };
      }

      const context: ToolExecutionContext = {
        elicitInput: (params) => server.elicitInput(params),
      };

      try {
        const result = await toolDef.handler((args as Record<string, unknown>) || {}, context);
        log.debug('Tool call completed', { tool: name, resultLength: result.length });

        return {
          content: [{ type: 'text', text: result }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error('Tool call failed', error, { tool: name });

        return {
          content: [{ type: 'text', text: JSON.stringify({ error: errorMessage }) }],
          isError: true,
        };
      }
    });

    // --- Resource handlers (use VaultResources directly) ---

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const notes = this.vaultResources.listNotes();
      log.debug('Listing resources', { count: notes.length });

      return {
        resources: notes.map((note) => ({
          uri: `vault://note/${note.path}`,
          name: note.name,
          mimeType: 'text/markdown',
        })),
      };
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      return {
        resourceTemplates: [
          {
            uriTemplate: 'vault://note/{path}',
            name: 'Vault Note',
            description: 'A markdown note in the Obsidian vault',
            mimeType: 'text/markdown',
          },
        ],
      };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      const match = uri.match(/^vault:\/\/note\/(.+)$/);
      if (!match) {
        throw new Error(`Invalid resource URI: ${uri}. Expected vault://note/{path}`);
      }

      const path = decodeURIComponent(match[1]);
      const content = await this.vaultResources.readFile(path);
      if (content === null) {
        throw new Error(`Note not found: ${path}`);
      }

      log.debug('Read resource', { uri, path, size: content.length });

      return {
        contents: [{ uri, mimeType: 'text/markdown', text: content }],
      };
    });

    // --- Subscription handlers ---

    server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      const { uri } = request.params;
      if (!this.resourceSubscriptions.has(uri)) {
        this.resourceSubscriptions.set(uri, new Set());
      }
      this.resourceSubscriptions.get(uri)!.add(server);
      log.debug('Resource subscription added', { uri, subscribers: this.resourceSubscriptions.get(uri)!.size });
      return {};
    });

    server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      const { uri } = request.params;
      const subscribers = this.resourceSubscriptions.get(uri);
      if (subscribers) {
        subscribers.delete(server);
        if (subscribers.size === 0) this.resourceSubscriptions.delete(uri);
      }
      log.debug('Resource subscription removed', { uri });
      return {};
    });

    // --- Completion handler ---

    server.setRequestHandler(CompleteRequestSchema, async (request) => {
      const { ref, argument } = request.params;

      // Complete vault note paths for resource template references
      if (ref.type === 'ref/resource' && argument.name === 'path') {
        const paths = this.vaultResources.getVaultPaths(argument.value);
        return { completion: { values: paths, hasMore: paths.length >= 100 } };
      }

      log.debug('No completions for ref', { refType: ref.type, argument: argument.name });
      return { completion: { values: [] } };
    });

    // --- Roots change notification ---

    server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
      await this.logClientRoots(server);
    });
  }

  /** Query and log the client's declared roots (best-effort — not all clients support roots) */
  private async logClientRoots(server: Server): Promise<void> {
    try {
      const { roots } = await server.listRoots();
      if (roots.length > 0) {
        log.info('Client roots detected', {
          count: roots.length,
          roots: roots.map((r) => r.name ?? r.uri),
        });
      }
    } catch {
      log.debug('Client does not support roots');
    }
  }
}
