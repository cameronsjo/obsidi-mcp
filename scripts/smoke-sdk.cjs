// Load the delivered plugin bundle, not a separately compiled MCPServer harness.
// Obsidian owns these APIs in production; this smoke supplies an in-memory host.
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createServer } = require('node:net');
const { resolve } = require('node:path');

const stderrLog = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`);
console.debug = stderrLog;
console.info = stderrLog;
console.warn = stderrLog;
console.error = stderrLog;

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function main() {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const port = await freePort();
  let startup;
  let trashed = false;
  let confirmations = 0;
  class TAbstractFile {}
  class TFile extends TAbstractFile {}
  class TFolder extends TAbstractFile {}
  const note = Object.assign(new TFile(), {
    path: 'sample.md', name: 'sample.md', basename: 'sample', extension: 'md',
    stat: { size: 8, mtime: 0, ctime: 0 },
  });
  const app = {
    vault: {
      getFiles: () => [note],
      getMarkdownFiles: () => [note],
      getAbstractFileByPath: (path) => path === note.path && !trashed ? note : null,
      cachedRead: async () => '# sample',
      trash: async () => { trashed = true; },
      delete: async () => { throw new Error('Permanent deletion must not run in this smoke'); },
      on: () => {}, off: () => {},
    },
    workspace: { onLayoutReady: (callback) => { startup = callback(); } },
  };
  class Plugin {
    constructor(app) { this.app = app; this.manifest = { version: 'smoke' }; }
    async loadData() {
      return { settings: { enabled: true, transport: 'http', httpPort: port,
        cliBridge: { enabled: false, binaryPath: '', timeout: 10000 } } };
    }
    async saveData() {}
    addCommand() {}
    addSettingTab() {}
  }
  class PluginSettingTab {}
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'obsidian') return { Plugin, PluginSettingTab, TAbstractFile, TFile, TFolder };
    return originalLoad.call(this, request, parent, isMain);
  };
  let plugin;
  const clients = [];
  try {
    const DeliveredPlugin = require(resolve(__dirname, '../main.js')).default;
    plugin = new DeliveredPlugin(app);
    await plugin.onload();
    await startup;
    assert.equal(plugin.isServerRunning(), true);
    const exchanges = [];
    const modern = new Client({ name: 'bundle-modern-smoke', version: '1' }, {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    });
    clients.push(modern);
    await modern.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (typeof init?.body === 'string') {
          const body = JSON.parse(init.body);
          exchanges.push({ method: body.method, headers: new Headers(init.headers),
            meta: body.params?._meta, session: response.headers.get('Mcp-Session-Id') });
        }
        return response;
      },
    }));
    const listed = await modern.listTools();
    assert(listed.tools.length >= 28, 'Delivered plugin must expose its built-in tools');
    assert(listed.tools.some((tool) => tool.name === 'delete'));
    assert.equal(listed.ttlMs, 0);
    assert.equal(listed.cacheScope, 'private');
    const blocked = await modern.callTool({ name: 'delete', arguments: { path: note.path } });
    assert.match(JSON.parse(blocked.content[0].text).error, /confirmation/i);
    assert.equal(trashed, false, 'Modern confirmation failure must not mutate even the in-memory host');
    assert(!exchanges.some((exchange) => exchange.method === 'initialize'));
    assert(exchanges.every((exchange) => exchange.session === null));
    const call = exchanges.find((exchange) => exchange.method === 'tools/call');
    assert.equal(call.headers.get('Mcp-Method'), 'tools/call');
    assert.equal(call.headers.get('Mcp-Name'), 'delete');
    assert.equal(call.meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
    console.log(`Delivered main.js: modern stateless HTTP listed ${listed.tools.length} built-ins; mutation blocked without confirmation`);

    const legacy = new Client({ name: 'bundle-legacy-smoke', version: '1' }, {
      versionNegotiation: { mode: 'legacy' }, capabilities: { elicitation: { form: {} } },
    });
    clients.push(legacy);
    legacy.setRequestHandler('elicitation/create', async () => {
      confirmations += 1;
      return { action: 'accept', content: { confirm: true } };
    });
    await legacy.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    assert((await legacy.listTools()).tools.length >= 28);
    const accepted = await legacy.callTool({ name: 'delete', arguments: { path: note.path } });
    assert.equal(JSON.parse(accepted.content[0].text).success, true);
    assert.equal(confirmations, 1);
    assert.equal(trashed, true);
    console.log('Delivered main.js: legacy HTTP confirmed the in-memory trash operation through real SDK elicitation');
  } finally {
    for (const client of clients) await client.close();
    if (plugin) await plugin.onunload();
    Module._load = originalLoad;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
