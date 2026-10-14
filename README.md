# Obsidi MCP

Expose Obsidian vault tools via Model Context Protocol (MCP) server.

## Features

- **MCP Server** - Serve vault tools over stdio, HTTP (StreamableHTTP), or SSE transports
- **28+ Built-in Tools** - Read, write, search, tag, link, and manage vault notes
- **CLI Bridge** - Obsidian Sync history, file recovery, and diff tools (v1.12+)
- **Tool Provider Registry** - Other plugins register additional tools at runtime
- **Vault Resources** - MCP resource subscriptions with live vault change notifications
- **Session Persistence** - Hot-reload recovery for connected MCP clients

## Requirements

- Obsidian Desktop (not mobile - uses Node.js features)
- Node.js 20+ (required by MCP SDK v2)
- For CLI bridge: Obsidian CLI v1.12+

## Installation

### BRAT (Recommended)

Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install BRAT from Community Plugins
2. Add `cameronsjo/obsidi-mcp` as a beta plugin
3. Enable Obsidi MCP in Community Plugins

### Development

```bash
git clone https://github.com/cameronsjo/obsidi-mcp.git
cd obsidi-mcp

npm install
npm run build

# Exercise the delivered main.js bundle with an in-memory Obsidian host
npm run test:smoke

# For development with auto-rebuild
npm run dev
```

### Linking to Obsidian

Create a symlink from your Obsidian vault's plugins folder:

```bash
ln -sfn /path/to/obsidi-mcp /path/to/vault/.obsidian/plugins/obsidi-mcp
```

## Usage

HTTP supports stateless MCP protocol `2026-07-28` and keeps legacy HTTP/SSE
clients working. Both protocol eras are supported over stdio. Modern notification
subscriptions are capped at 16 streams. `delete` and `sync_restore` still require
legacy elicitation: modern calls refuse these actions until the new multi-round-trip
confirmation flow is implemented. This never bypasses the confirmation prompt.

The smoke probe loads the built plugin and lists its tools over real HTTP; it
also checks modern stateless metadata and legacy confirmation against an in-memory
vault. It does not replace testing inside the Obsidian application.

1. Enable the plugin in Obsidian Settings > Community Plugins
2. Configure transport (stdio, HTTP, or SSE) in plugin settings
3. Connect your MCP client to the server

### Connecting Claude Code

For stdio transport, add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "obsidian",
      "args": ["--vault", "Your Vault Name", "--mcp"]
    }
  }
}
```

For HTTP transport:

```json
{
  "mcpServers": {
    "obsidian": {
      "url": "http://localhost:3000/mcp",
      "transport": "streamable-http"
    }
  }
}
```

## Configuration

Open Settings > Obsidi MCP to configure:

- **Transport**: stdio, HTTP (StreamableHTTP), SSE, or stdio + HTTP
- **HTTP Port**: Port for HTTP/SSE server (default: 3000)
- **Server Name**: Name exposed to MCP clients
- **CLI Bridge**: Enable Obsidian CLI tools for Sync history and file recovery

## Tools Available

### Vault Tools (28)

| Category | Tools |
|----------|-------|
| **Read** | `read_note`, `read_note_range`, `get_note_metadata`, `get_active_note` |
| **Write** | `create_note`, `modify_note`, `append_to_note`, `delete_note`, `rename` |
| **Search** | `search_vault`, `search_by_tag`, `search_by_date` |
| **Navigation** | `list_notes`, `list_folder`, `get_backlinks`, `get_outgoing_links` |
| **Tags** | `list_all_tags`, `manage_tags` |
| **Links** | `suggest_links`, `check_broken_links` |
| **Metadata** | `get_vault_stats`, `get_instructions` |
| **Semantic** | `semantic_search`, `find_similar` (requires RAG provider) |

### CLI Bridge Tools (7)

| Tool | Description |
|------|-------------|
| `sync_status` | Check Obsidian Sync connection status |
| `sync_history` | Get version history for a file |
| `sync_read` | Read a specific version of a file |
| `sync_restore` | Restore a file to a previous version |
| `file_diff` | Diff between two versions of a file |
| `file_history` | Get file modification history |
| `file_history_read` | Read a file at a specific history point |

## Plugin Integration

Other plugins can register tools with Obsidi MCP:

```typescript
// In your plugin's onload()
const mcp = this.app.plugins?.plugins?.['obsidi-mcp'];
if (mcp?.registerToolProvider) {
  mcp.registerToolProvider({
    id: 'my-plugin',
    name: 'My Plugin',
    tools: myToolDefinitions,
  });
}

// In your plugin's onunload()
const mcp = this.app.plugins?.plugins?.['obsidi-mcp'];
mcp?.unregisterToolProvider?.('my-plugin');
```

Tool providers registered later override built-in tools with the same name, enabling plugins to provide enhanced versions (e.g., RAG-powered search).

## Architecture

```
obsidi-mcp
├── MCPServer (stdio/HTTP/SSE transports)
│   ├── Tool dispatch (dynamic from registry)
│   ├── Vault resources (live subscriptions)
│   ├── Completions (path autocomplete)
│   ├── Elicitation (confirmation dialogs)
│   └── Log forwarding
├── ObsidianTools (28 built-in vault tools)
├── CLI Bridge (7 Obsidian CLI tools)
├── VaultResources (direct app.vault access)
└── Tool Provider Registry
    ├── Built-in tools (layer 1)
    ├── CLI bridge tools (layer 2)
    └── External providers (layer 3, last wins)
```

## Security

The HTTP/SSE server validates `Host` and `Origin` before parsing a request or routing it to MCP. By default, only `localhost`, `127.0.0.1`, and `[::1]` with the configured HTTP port are accepted; requests from other hosts or browser origins receive `403`. Stdio is unaffected.

The server still has **no authentication, no TLS, and no access control**. It is designed for local-only use by MCP clients running on the same machine. To explicitly permit a LAN or Tailscale client, set `MCP_ALLOWED_HOSTS` in the environment before starting Obsidian. Use a comma-separated hostname, `host:port`, or full `http://`/`https://` origin. A hostname uses the configured HTTP port; a full HTTPS origin defaults to port 443, which is useful behind a TLS reverse proxy. Wildcards, credentials, paths, and forwarded-header overrides are not accepted.

For example:

```bash
MCP_ALLOWED_HOSTS=100.64.0.12,https://mcp.example.com
```

The same validation applies to deprecated SSE endpoints. Allowlisting a host does not replace a secured reverse proxy or authentication.

**Do not expose the server to a network without a secured reverse proxy.** Anyone who can reach the HTTP port has full read/write access to your vault.

If you need remote access, place the server behind a reverse proxy that provides authentication, TLS, rate limiting, and role-based access control (e.g., Caddy, nginx, Cloudflare Tunnel).

## Troubleshooting

### Server not starting

Check Obsidian's developer console (Cmd+Option+I) for errors. The server status is visible in plugin settings.

### CLI bridge not available

Ensure Obsidian CLI is installed (v1.12+):

```bash
obsidian --version
```

### Port already in use

Change the HTTP port in plugin settings if port 3000 is occupied.

## License

[PolyForm Noncommercial 1.0.0](LICENSE)
