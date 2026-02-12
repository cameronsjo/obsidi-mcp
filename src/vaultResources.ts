import type { App, TAbstractFile, TFile } from 'obsidian';
import { createLogger } from './logger';

const log = createLogger('VaultResources');

/**
 * Direct vault access for MCP resource operations.
 *
 * Provides the 4 vault helpers that the MCP server needs for resource listing,
 * reading, change notifications, and path completion — without depending on
 * any tool provider plugin.
 */
export class VaultResources {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /** List all markdown notes in the vault as resource metadata */
  listNotes(): Array<{ path: string; name: string; size: number; mtime: number }> {
    return this.app.vault.getMarkdownFiles().map((file) => ({
      path: file.path,
      name: file.basename,
      size: file.stat.size,
      mtime: file.stat.mtime,
    }));
  }

  /** Read a vault file's content by path. Returns null if not found. */
  async readFile(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !('extension' in file)) return null;
    return this.app.vault.cachedRead(file as TFile);
  }

  /** Get vault file paths matching a prefix, for autocomplete */
  getVaultPaths(prefix?: string, limit = 100): string[] {
    const files = this.app.vault.getFiles();
    const paths = files.map((f) => f.path);
    if (!prefix) return paths.slice(0, limit);
    const lower = prefix.toLowerCase();
    return paths.filter((p) => p.toLowerCase().startsWith(lower)).slice(0, limit);
  }

  /** Register a callback for vault file change events. Returns unsubscribe function. */
  onVaultChange(
    callback: (event: 'create' | 'modify' | 'delete' | 'rename', path: string, oldPath?: string) => void
  ): () => void {
    const onCreate = (file: TAbstractFile) => {
      if ('extension' in file) callback('create', file.path);
    };
    const onModify = (file: TAbstractFile) => {
      if ('extension' in file) callback('modify', file.path);
    };
    const onDelete = (file: TAbstractFile) => {
      if ('extension' in file) callback('delete', file.path);
    };
    const onRename = (file: TAbstractFile, oldPath: string) => {
      if ('extension' in file) callback('rename', file.path, oldPath);
    };

    this.app.vault.on('create', onCreate);
    this.app.vault.on('modify', onModify);
    this.app.vault.on('delete', onDelete);
    this.app.vault.on('rename', onRename);

    log.debug('Vault change listener registered');

    return () => {
      this.app.vault.off('create', onCreate);
      this.app.vault.off('modify', onModify);
      this.app.vault.off('delete', onDelete);
      this.app.vault.off('rename', onRename);
      log.debug('Vault change listener removed');
    };
  }
}
