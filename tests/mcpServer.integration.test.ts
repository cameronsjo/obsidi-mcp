import { build } from 'esbuild';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MCPServer } from '../src/mcpServer';
import { ObsidianTools } from '../src/obsidianTools';
import { CLITools } from '../src/cliBridge/cliTools';
import { Logger } from '../src/logger';
import type { ToolDefinition } from '../src/types';

// Obsidian is types-only at runtime in this integration harness. The built-in
// delete tool only needs duck-typed vault objects for its mutation guard.
vi.mock('obsidian', () => ({
  TAbstractFile: class TAbstractFile {},
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

type ServerTransport = 'http' | 'sse';

function makeVaultResources() {
  return {
    listNotes: () => [{ path: 'readme.md', name: 'readme', size: 7, mtime: 0 }],
    readFile: async (path: string) => (path === 'readme.md' ? '# Readme' : null),
    getVaultPaths: (prefix?: string) => (prefix ? ['readme.md'].filter((path) => path.startsWith(prefix)) : ['readme.md']),
    onVaultChange: () => () => {},
  };
}

function makeToolDefinitions() {
  return [
    {
      name: 'echo',
      description: 'Echo a message',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      handler: async (params: Record<string, unknown>) => JSON.stringify({ message: params.message }),
    },
  ] satisfies ToolDefinition[];
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a test port');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function startServer(
  transport: ServerTransport,
  tools: ToolDefinition[] = makeToolDefinitions(),
): Promise<{ server: MCPServer; url: string }> {
  const port = await freePort();
  const server = new MCPServer(
    makeVaultResources() as never,
    () => tools,
    {
      name: 'obsidi-mcp-integration',
      version: 'test',
      transport,
      httpPort: port,
      cleanupIntervalMs: 60_000,
    },
  );
  await server.start();
  return { server, url: `http://127.0.0.1:${port}` };
}

function boundHost(server: MCPServer): string {
  const listeners = server as unknown as {
    httpServer: { address: () => AddressInfo | string | null } | null;
    sseServer: { address: () => AddressInfo | string | null } | null;
  };
  const address = (listeners.httpServer ?? listeners.sseServer)?.address();
  if (!address || typeof address === 'string') throw new Error('Server has no TCP address');
  return address.address;
}

async function connectHttp(url: string, modern: boolean): Promise<Client> {
  const client = new Client(
    { name: modern ? 'modern-test-client' : 'legacy-test-client', version: '1.0.0' },
    { versionNegotiation: { mode: modern ? { pin: '2026-07-28' } : 'legacy' } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  return client;
}

async function closeClient(client: Client): Promise<void> {
  await client.close().catch(() => {});
}

async function rawRequest(
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; text: string }> {
  const target = new URL(url);
  const requestHeaders = { ...headers };
  if (body !== undefined && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-length')) {
    requestHeaders['content-length'] = String(Buffer.byteLength(body));
  }
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: body === undefined ? 'GET' : 'POST',
      headers: requestHeaders,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    if (headers.host !== undefined) expect(request.getHeader('host')).toBe(headers.host);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

describe('MCP SDK 2.3.1 transport integration', () => {
  const initialAllowedHosts = process.env.MCP_ALLOWED_HOSTS;
  const initialBindHost = process.env.MCP_BIND_HOST;

  beforeEach(() => {
    Logger.setEnabled(false);
  });

  afterEach(() => {
    if (initialAllowedHosts === undefined) delete process.env.MCP_ALLOWED_HOSTS;
    else process.env.MCP_ALLOWED_HOSTS = initialAllowedHosts;
    if (initialBindHost === undefined) delete process.env.MCP_BIND_HOST;
    else process.env.MCP_BIND_HOST = initialBindHost;
  });

  it.each(['http', 'sse'] as const)('binds %s to loopback by default', async (transport) => {
    delete process.env.MCP_BIND_HOST;
    const { server } = await startServer(transport);
    try {
      expect(boundHost(server)).toBe('127.0.0.1');
    } finally {
      await server.stop();
    }
  });

  it('binds to an explicit MCP_BIND_HOST and uses the host allowlist for remote authorities', async () => {
    process.env.MCP_BIND_HOST = '0.0.0.0';
    process.env.MCP_ALLOWED_HOSTS = 'mcp.lan.test';
    const { server, url } = await startServer('http');
    const port = new URL(url).port;
    try {
      expect(boundHost(server)).toBe('0.0.0.0');
      const allowed = await rawRequest(`${url}/health`, { host: `mcp.lan.test:${port}` });
      expect(allowed.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('allows loopback hosts, rejects bad Host and Origin before body parsing, and accepts no Origin', async () => {
    const { server, url } = await startServer('http');
    const port = new URL(url).port;
    try {
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
        await expect(rawRequest(`${url}/health`, { host })).resolves.toMatchObject({ status: 200 });
      }

      const noOrigin = await rawRequest(`${url}/health`, { host: `127.0.0.1:${port}` });
      expect(noOrigin.status).toBe(200);

      const badHost = await rawRequest(
        `${url}/mcp`,
        { host: `attacker.example:${port}`, 'content-type': 'application/json' },
        '{not-json',
      );
      expect(badHost.status).toBe(403);

      const crossOriginHost = `127.0.0.1:${port}`;
      const crossOriginCases = [
        `http://127.0.0.1:${Number(port) + 1}`,
        `https://127.0.0.1:${port}`,
        `http://attacker.example:${port}`,
      ];
      for (const origin of crossOriginCases) {
        const denied = await rawRequest(`${url}/mcp`, {
          host: crossOriginHost,
          origin,
          'content-type': 'application/json',
        }, '{not-json');
        expect(denied.status).toBe(403);
      }
    } finally {
      await server.stop();
    }
  });

  it('applies Host and Origin validation to deprecated SSE health and messages routes', async () => {
    const { server, url } = await startServer('sse');
    const port = new URL(url).port;
    try {
      const allowed = await rawRequest(`${url}/health`, { host: `127.0.0.1:${port}` });
      expect(allowed.status).toBe(200);

      const deniedHealth = await rawRequest(`${url}/health`, { host: `attacker.example:${port}` });
      expect(deniedHealth.status).toBe(403);

      const deniedMessages = await rawRequest(
        `${url}/messages?sessionId=invalid`,
        { host: `127.0.0.1:${port}`, origin: `http://attacker.example:${port}`, 'content-type': 'application/json' },
        '{not-json',
      );
      expect(deniedMessages.status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  it('admits an explicit host and matching origin from MCP_ALLOWED_HOSTS', async () => {
    process.env.MCP_ALLOWED_HOSTS = 'mcp.lan.test';
    const { server, url } = await startServer('http');
    const port = new URL(url).port;
    try {
      const allowed = await rawRequest(`${url}/health`, {
        host: `mcp.lan.test:${port}`,
        origin: `http://mcp.lan.test:${port}`,
      });
      expect(allowed.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('admits an explicit HTTPS origin with its reverse-proxy default port', async () => {
    process.env.MCP_ALLOWED_HOSTS = 'https://mcp.example.test';
    const { server, url } = await startServer('http');
    try {
      const allowed = await rawRequest(`${url}/health`, {
        host: 'mcp.example.test',
        origin: 'https://mcp.example.test',
      });
      expect(allowed.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('fails closed when MCP_ALLOWED_HOSTS contains an invalid entry', async () => {
    process.env.MCP_ALLOWED_HOSTS = '*';
    const port = await freePort();
    const server = new MCPServer(
      makeVaultResources() as never,
      makeToolDefinitions,
      { name: 'invalid-allowlist', version: 'test', transport: 'http', httpPort: port },
    );
    await expect(server.start()).rejects.toThrow(/MCP_ALLOWED_HOSTS/);
    expect(server.isServerRunning()).toBe(false);
    await server.stop();
  });

  it('serves modern stateless HTTP and retained legacy HTTP with real SDK clients', async () => {
    const { server, url } = await startServer('http');
    const clients: Client[] = [];
    try {
      const modern = await connectHttp(url, true);
      clients.push(modern);
      expect((await modern.listTools()).tools.map((tool) => tool.name)).toContain('echo');
      await expect(modern.callTool({ name: 'echo', arguments: { message: 'modern' } })).resolves.toMatchObject({
        content: [{ type: 'text', text: '{"message":"modern"}' }],
      });

      const legacy = await connectHttp(url, false);
      clients.push(legacy);
      expect((await legacy.listTools()).tools.map((tool) => tool.name)).toContain('echo');
      await expect(legacy.callTool({ name: 'echo', arguments: { message: 'legacy' } })).resolves.toMatchObject({
        content: [{ type: 'text', text: '{"message":"legacy"}' }],
      });
    } finally {
      for (const client of clients) await closeClient(client);
      await server.stop();
    }
  });

  it('serves deprecated SSE with the real SDK client', async () => {
    const { server, url } = await startServer('sse');
    const client = new Client({ name: 'sse-test-client', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    try {
      await client.connect(new SSEClientTransport(new URL(`${url}/sse`)));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('echo');
    } finally {
      await closeClient(client);
      await server.stop();
    }
  });

  it('keeps modern destructive built-ins fail-closed without mutating', async () => {
    const file = { path: 'danger.md', extension: 'md', basename: 'danger' };
    const vault = {
      getAbstractFileByPath: vi.fn((path: string) => (path === 'danger.md' ? file : null)),
      delete: vi.fn(),
      trash: vi.fn(),
    };
    const builtInTools = new ObsidianTools({ vault } as never).getToolDefinitions();
    const executor = { execute: vi.fn() };
    const cliTools = new CLITools(executor as never).getToolDefinitions();
    const { server, url } = await startServer('http', [
      builtInTools.find((tool) => tool.name === 'delete')!,
      cliTools.find((tool) => tool.name === 'sync_restore')!,
    ]);
    const client = await connectHttp(url, true);
    try {
      const deletion = await client.callTool({ name: 'delete', arguments: { path: 'danger.md' } });
      const deletionBody = JSON.parse(String((deletion.content?.[0] as { text?: unknown } | undefined)?.text));
      expect(deletionBody.error).toMatch(/confirmation/i);
      expect(vault.delete).not.toHaveBeenCalled();
      expect(vault.trash).not.toHaveBeenCalled();

      const restore = await client.callTool({ name: 'sync_restore', arguments: { path: 'danger.md', version: 3 } });
      const restoreBody = JSON.parse(String((restore.content?.[0] as { text?: unknown } | undefined)?.text));
      expect(restoreBody.error).toMatch(/confirmation/i);
      expect(executor.execute).not.toHaveBeenCalled();
    } finally {
      await closeClient(client);
      await server.stop();
    }
  });

  it('enforces the bounded modern subscription capacity', async () => {
    const { server, url } = await startServer('http');
    const clients: Client[] = [];
    const subscriptions: Array<{ close: () => Promise<void> }> = [];
    try {
      for (let index = 0; index < 17; index += 1) clients.push(await connectHttp(url, true));
      const outcomes = await Promise.all(
        clients.map(async (client) => {
          try {
            const subscription = await client.listen({ resourcesListChanged: true });
            subscriptions.push(subscription);
            return { ok: true, error: '' };
          } catch (error) {
            return { ok: false, error: String(error) };
          }
        }),
      );
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(16);
      expect(outcomes.some((outcome) => /Subscription limit reached/i.test(outcome.error))).toBe(true);
    } finally {
      for (const subscription of subscriptions) await subscription.close().catch(() => {});
      for (const client of clients) await closeClient(client);
      await server.stop();
    }
  });

  it('serves stdio through the shipped MCPServer with a real SDK client', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'obsidi-mcp-sdk-'));
    const harnessPath = join(tempDir, 'stdio-harness.cjs');
    const client = new Client({ name: 'stdio-test-client', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    try {
      await build({
        entryPoints: [resolve('tests/stdio-harness.ts')],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node22',
        outfile: harnessPath,
        external: ['obsidian'],
      });
      const transport = new StdioClientTransport({ command: process.execPath, args: [harnessPath], stderr: 'ignore' });
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('stdio_echo');
      await expect(client.callTool({ name: 'stdio_echo', arguments: { message: 'ok' } })).resolves.toMatchObject({
        content: [{ type: 'text', text: '{"message":"ok"}' }],
      });
    } finally {
      await closeClient(client);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('serves modern stdio through the shipped MCPServer with a pinned SDK client', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'obsidi-mcp-sdk-modern-'));
    const harnessPath = join(tempDir, 'stdio-harness.cjs');
    const client = new Client(
      { name: 'modern-stdio-test-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    try {
      await build({
        entryPoints: [resolve('tests/stdio-harness.ts')],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node22',
        outfile: harnessPath,
        external: ['obsidian'],
      });
      const transport = new StdioClientTransport({ command: process.execPath, args: [harnessPath], stderr: 'ignore' });
      transport.stderr?.on('data', (chunk) => process.stderr.write(String(chunk)));
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('stdio_echo');
      const updates: unknown[] = [];
      client.setNotificationHandler('notifications/resources/updated', async (notification) => {
        updates.push(notification);
      });
      const subscription = await client.listen({ resourceSubscriptions: ['vault://note/stdio.md'] });
      await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0), { timeout: 2_000 });
      expect(JSON.stringify(updates[0])).toContain('vault://note/stdio.md');
      await subscription.close();
    } finally {
      await closeClient(client);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 10_000);
});
