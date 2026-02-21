---
name: obsidian-mcp
description: "Get started with obsidi-mcp — what it is, how to set it up, and how to use it"
---


Guide the user through getting started with **obsidi-mcp**.

## About

An Obsidian community plugin that exposes vault operations as an MCP server. Provides 28+ built-in vault tools (read, write, search, tag, link, manage notes) plus 7 CLI bridge tools for Sync history and file recovery. Supports stdio, HTTP (StreamableHTTP), and SSE transports. Other plugins can register additional tools at runtime via the Tool Provider Registry.

## Prerequisites

Check that the user has the following installed/configured:

- Obsidian Desktop (not mobile — uses Node.js features)
- Node.js 18+
- npm
- Git
- For CLI bridge tools: Obsidian CLI v1.12+ (`obsidian --version` to verify)
- (Optional) BRAT plugin for easy installation without development setup

## Setup

Walk the user through initial setup:

1. Clone the repo:
   ```bash
   git clone https://github.com/cameronsjo/obsidi-mcp.git
   cd obsidi-mcp
   ```
2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```
3. Symlink the plugin into your Obsidian vault's plugins folder:
   ```bash
   ln -sfn /path/to/obsidi-mcp /path/to/your-vault/.obsidian/plugins/obsidi-mcp
   ```
4. In Obsidian, go to Settings > Community Plugins and enable **Obsidi MCP**.
5. Configure transport (stdio, HTTP, or SSE) in the plugin's settings tab (Settings > Obsidi MCP).

## First Use

Guide the user through their first interaction with the product:

1. After enabling the plugin, open the plugin settings and confirm the server status shows as running.
2. For **HTTP transport** (default port 3000), test with curl:
   ```bash
   curl http://localhost:3000/health
   ```
3. For **stdio transport**, add to your Claude Code MCP config:
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
4. For **HTTP transport**, add to your Claude Code MCP config:
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
5. Try a basic tool call like `list_notes` or `get_vault_stats` to confirm connectivity.

## Key Files

Point the user to the most important files for understanding the project:

- `main.ts` — Plugin entry point, `onload()`/`onunload()` lifecycle
- `src/mcpServer.ts` — MCP server implementation, transport setup, tool dispatch
- `src/obsidianTools.ts` — 28 built-in vault tool definitions and handlers
- `src/cliBridge/` — CLI bridge tools for Sync history and file recovery
- `src/vaultResources.ts` — MCP resource subscriptions with live vault change notifications
- `src/settingsTab.ts` — Plugin settings UI configuration
- `manifest.json` — Obsidian plugin manifest (id, version, min app version)

## Common Tasks

- **Development with auto-rebuild**:
  ```bash
  npm run dev
  ```
  Then reload the plugin in Obsidian (Ctrl/Cmd+P > "Reload app without saving").
- **Production build**:
  ```bash
  npm run build
  ```
- **Run tests**:
  ```bash
  npm test
  ```
- **Register tools from another plugin**: In your plugin's `onload()`:
  ```typescript
  const mcp = this.app.plugins?.plugins?.['obsidi-mcp'];
  if (mcp?.registerToolProvider) {
    mcp.registerToolProvider({ id: 'my-plugin', name: 'My Plugin', tools: myTools });
  }
  ```
- **Check server status**: Open Obsidian Settings > Obsidi MCP. Server status is displayed at the top.
