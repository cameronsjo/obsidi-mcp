// Child-process harness for the real stdio transport smoke. Keep all logs on
// stderr before loading MCPServer so stdout remains JSON-RPC-only.
void (async () => {
  const stderrLog = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(' ')}\n`);
  };
  console.debug = stderrLog;
  console.info = stderrLog;
  console.warn = stderrLog;
  console.error = stderrLog;

  const { MCPServer } = await import('../src/mcpServer');

  type VaultChange = (event: 'create' | 'modify' | 'delete' | 'rename', path: string, oldPath?: string) => void;
  let onVaultChange: VaultChange | undefined;
  const vaultResources = {
    listNotes: () => [{ path: 'stdio.md', name: 'stdio', size: 5, mtime: 0 }],
    readFile: async (path: string) => (path === 'stdio.md' ? '# stdio' : null),
    getVaultPaths: () => ['stdio.md'],
    onVaultChange: (callback: VaultChange) => {
      onVaultChange = callback;
      return () => {
        onVaultChange = undefined;
      };
    },
  };

  const server = new MCPServer(
    vaultResources as never,
    () => [
      {
        name: 'stdio_echo',
        description: 'Echo a message over stdio',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
        handler: async (params: Record<string, unknown>) => JSON.stringify({ message: params.message }),
      },
    ],
    {
      name: 'obsidi-mcp-stdio-smoke',
      version: 'test',
      transport: 'stdio',
      httpPort: 0,
    },
  );

  await server.start();
  const changeTimer = setInterval(() => {
    if (!onVaultChange) return;
    onVaultChange('modify', 'stdio.md');
    clearInterval(changeTimer);
  }, 500);
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
