# Changelog

## Unreleased

### Changed

* Migrated transport serving to the official MCP TypeScript SDK 2.3.1 packages (Node adapter 2.1.1), including stateless 2026-07-28 HTTP, retained legacy HTTP/SSE, and dual-era stdio support. See the [official v2.3.1 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.3.1).
* Modern subscriptions are bounded to 16 concurrent streams and retain resource/tool change notifications; the existing 100 KiB JSON request boundary remains in place.
* HTTP and deprecated SSE now validate Host and Origin before body parsing, defaulting to loopback plus the configured port. Set `MCP_ALLOWED_HOSTS` for explicit LAN, Tailscale, or reverse-proxy authorities; this is validation only and does not add authentication.

### Follow-up

* `delete` and `sync_restore` remain confirmation-gated for legacy clients. Modern 2026-07-28 calls fail closed until these destructive tools are migrated to the SDK's `inputRequired`/MRTR elicitation flow; the legacy SSE package and server-side elicitation path remain for compatibility during that migration.

## 0.1.0 (2026-02-12)

### Features

* Initial release - standalone MCP server for Obsidian
* 28+ built-in vault tools (ObsidianTools)
* 7 CLI bridge tools (sync history, file recovery, diff)
* Tool provider registry for other plugins
* stdio, HTTP (StreamableHTTP), and SSE transports
* Vault resource subscriptions via MCP resources
* Session persistence for hot-reload recovery
