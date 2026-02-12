import { App, PluginSettingTab, Setting } from 'obsidian';
import type ObsidiMCPPlugin from '../main';
import type { MCPTransportType } from './types';

export class ObsidiMCPSettingsTab extends PluginSettingTab {
  plugin: ObsidiMCPPlugin;

  constructor(app: App, plugin: ObsidiMCPPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.addMCPServerSettings(containerEl);
    this.addCLIBridgeSettings(containerEl);
  }

  private addMCPServerSettings(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'MCP Server' });

    new Setting(containerEl)
      .setName('Enable MCP server')
      .setDesc('Start the MCP server automatically when the plugin loads')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Server name')
      .setDesc('Name exposed to MCP clients')
      .addText((text) =>
        text
          .setPlaceholder('obsidi-mcp')
          .setValue(this.plugin.settings.serverName)
          .onChange(async (value) => {
            this.plugin.settings.serverName = value || 'obsidi-mcp';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Transport')
      .setDesc('How MCP clients connect to the server')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('http', 'HTTP (StreamableHTTP)')
          .addOption('stdio', 'stdio (subprocess)')
          .addOption('sse', 'SSE (deprecated)')
          .addOption('both', 'stdio + HTTP')
          .setValue(this.plugin.settings.transport)
          .onChange(async (value) => {
            this.plugin.settings.transport = value as MCPTransportType;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.transport !== 'stdio') {
      new Setting(containerEl)
        .setName('HTTP port')
        .setDesc('Port for the HTTP/SSE server')
        .addText((text) =>
          text
            .setPlaceholder('3000')
            .setValue(String(this.plugin.settings.httpPort))
            .onChange(async (value) => {
              const port = parseInt(value, 10);
              if (!isNaN(port) && port > 0 && port <= 65535) {
                this.plugin.settings.httpPort = port;
                await this.plugin.saveSettings();
              }
            })
        );
    }

    // Server status display
    const statusSetting = new Setting(containerEl)
      .setName('Server status')
      .setDesc(this.plugin.isServerRunning() ? 'Running' : 'Stopped');

    statusSetting.addButton((button) =>
      button
        .setButtonText(this.plugin.isServerRunning() ? 'Stop' : 'Start')
        .onClick(async () => {
          if (this.plugin.isServerRunning()) {
            // Access the private method via the plugin's command
            this.app.commands.executeCommandById('obsidi-mcp:stop-mcp-server');
          } else {
            this.app.commands.executeCommandById('obsidi-mcp:start-mcp-server');
          }
          // Refresh display after a brief delay for server state to settle
          setTimeout(() => this.display(), 500);
        })
    );

    // Connection info
    if (this.plugin.isServerRunning() && this.plugin.settings.transport !== 'stdio') {
      const configEl = containerEl.createEl('div', { cls: 'setting-item' });
      const infoEl = configEl.createEl('div', { cls: 'setting-item-info' });
      infoEl.createEl('div', { cls: 'setting-item-name', text: 'Connection URL' });
      const descEl = infoEl.createEl('div', { cls: 'setting-item-description' });

      const pre = descEl.createEl('pre');
      const code = pre.createEl('code');

      if (this.plugin.settings.transport === 'sse') {
        code.textContent = JSON.stringify({
          url: `http://localhost:${this.plugin.settings.httpPort}/sse`,
          transport: 'sse',
        }, null, 2);
      } else {
        code.textContent = JSON.stringify({
          url: `http://localhost:${this.plugin.settings.httpPort}/mcp`,
          transport: 'streamable-http',
        }, null, 2);
      }
    }
  }

  private addCLIBridgeSettings(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'CLI Bridge' });

    const descEl = containerEl.createEl('p', { cls: 'setting-item-description' });
    descEl.appendText('Exposes Obsidian Sync history, file recovery, and diff tools via the Obsidian CLI (v1.12+). Desktop only.');

    new Setting(containerEl)
      .setName('Enable CLI bridge')
      .setDesc('Expose CLI-backed tools (sync history, file recovery, diff)')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.cliBridge.enabled).onChange(async (value) => {
          this.plugin.settings.cliBridge.enabled = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.cliBridge.enabled) {
      new Setting(containerEl)
        .setName('Binary path')
        .setDesc('Path to the Obsidian CLI binary (leave empty to auto-detect)')
        .addText((text) =>
          text
            .setPlaceholder('Auto-detect')
            .setValue(this.plugin.settings.cliBridge.binaryPath)
            .onChange(async (value) => {
              this.plugin.settings.cliBridge.binaryPath = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName('Command timeout')
        .setDesc('Maximum time in milliseconds for CLI commands')
        .addText((text) =>
          text
            .setPlaceholder('10000')
            .setValue(String(this.plugin.settings.cliBridge.timeout))
            .onChange(async (value) => {
              const timeout = parseInt(value, 10);
              if (!isNaN(timeout) && timeout > 0) {
                this.plugin.settings.cliBridge.timeout = timeout;
                await this.plugin.saveSettings();
              }
            })
        );
    }
  }
}
