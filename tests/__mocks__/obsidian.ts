/**
 * Mock implementation of obsidian module for testing
 */

export class TAbstractFile {
  path: string = '';
  name: string = '';
  vault: any = null;
  parent: any = null;
}

export class TFile extends TAbstractFile {
  basename: string = '';
  extension: string = 'md';
  stat: { ctime: number; mtime: number; size: number } = {
    ctime: Date.now(),
    mtime: Date.now(),
    size: 0,
  };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.parent === null;
  }
}

export interface App {
  vault: Vault;
  workspace: Workspace;
  metadataCache: MetadataCache;
  fileManager: FileManager;
}

export interface Vault {
  adapter: { basePath: string };
  getAbstractFileByPath(path: string): TAbstractFile | null;
  getRoot(): TFolder;
  getMarkdownFiles(): TFile[];
  getFiles(): TFile[];
  read(file: TFile): Promise<string>;
  cachedRead(file: TFile): Promise<string>;
  create(path: string, content: string): Promise<TFile>;
  modify(file: TFile, content: string): Promise<void>;
  createFolder(path: string): Promise<void>;
  delete(file: TAbstractFile, force?: boolean): Promise<void>;
  on(event: string, callback: (...args: any[]) => void): { unload(): void };
}

export interface Workspace {
  getActiveFile(): TFile | null;
  getLeaf(newLeaf?: boolean): WorkspaceLeaf;
  activeLeaf: WorkspaceLeaf | null;
  getActiveViewOfType<T>(type: new () => T): T | null;
  onLayoutReady(callback: () => void): void;
}

export interface WorkspaceLeaf {
  openFile(file: TFile): Promise<void>;
  view: any;
}

export interface MetadataCache {
  getFileCache(file: TFile): CachedMetadata | null;
  getTags(): Record<string, number>;
  resolvedLinks: Record<string, Record<string, number>>;
  unresolvedLinks: Record<string, Record<string, number>>;
  getFirstLinkpathDest(link: string, sourcePath: string): TFile | null;
}

export interface CachedMetadata {
  frontmatter?: Record<string, unknown>;
  tags?: Array<{ tag: string; position: { start: { line: number } } }>;
  headings?: Array<{ heading: string; level: number; position: { start: { line: number } } }>;
  links?: Array<{ link: string; original: string; position: { start: { line: number } } }>;
  embeds?: Array<{ link: string; original: string; position: { start: { line: number } } }>;
}

export interface FileManager {
  renameFile(file: TAbstractFile, newPath: string): Promise<void>;
}

export class ItemView {
  app: App = {} as App;
  containerEl: HTMLElement = {} as HTMLElement;
  contentEl: HTMLElement = {} as HTMLElement;
  leaf: WorkspaceLeaf = {} as WorkspaceLeaf;

  getViewType(): string { return ''; }
  getDisplayText(): string { return ''; }
  onOpen(): Promise<void> { return Promise.resolve(); }
  onClose(): Promise<void> { return Promise.resolve(); }
}

export class Plugin {
  app: App = {} as App;
  manifest: any = {};

  onload(): Promise<void> | void {}
  onunload(): void {}
  addCommand(cmd: any): any {}
  addRibbonIcon(icon: string, title: string, callback: () => void): HTMLElement {
    return {} as HTMLElement;
  }
  addSettingTab(tab: any): void {}
  registerView(type: string, factory: () => ItemView): void {}
  loadData(): Promise<any> { return Promise.resolve(null); }
  saveData(data: any): Promise<void> { return Promise.resolve(); }
}

export class PluginSettingTab {
  app: App = {} as App;
  plugin: Plugin = {} as Plugin;
  containerEl: HTMLElement = {} as HTMLElement;

  display(): void {}
  hide(): void {}
}

export class Setting {
  settingEl: HTMLElement = {} as HTMLElement;
  infoEl: HTMLElement = {} as HTMLElement;
  nameEl: HTMLElement = {} as HTMLElement;
  descEl: HTMLElement = {} as HTMLElement;
  controlEl: HTMLElement = {} as HTMLElement;

  constructor(containerEl: HTMLElement) {}

  setName(name: string): this { return this; }
  setDesc(desc: string): this { return this; }
  addText(cb: (text: TextComponent) => void): this { return this; }
  addTextArea(cb: (text: TextAreaComponent) => void): this { return this; }
  addToggle(cb: (toggle: ToggleComponent) => void): this { return this; }
  addDropdown(cb: (dropdown: DropdownComponent) => void): this { return this; }
  addButton(cb: (button: ButtonComponent) => void): this { return this; }
  addSlider(cb: (slider: SliderComponent) => void): this { return this; }
  setClass(cls: string): this { return this; }
}

export class TextComponent {
  inputEl: HTMLInputElement = {} as HTMLInputElement;
  setValue(value: string): this { return this; }
  getValue(): string { return ''; }
  setPlaceholder(placeholder: string): this { return this; }
  onChange(callback: (value: string) => void): this { return this; }
}

export class TextAreaComponent extends TextComponent {
  inputEl: HTMLTextAreaElement = {} as HTMLTextAreaElement;
}

export class ToggleComponent {
  toggleEl: HTMLElement = {} as HTMLElement;
  setValue(value: boolean): this { return this; }
  getValue(): boolean { return false; }
  onChange(callback: (value: boolean) => void): this { return this; }
}

export class DropdownComponent {
  selectEl: HTMLSelectElement = {} as HTMLSelectElement;
  addOption(value: string, display: string): this { return this; }
  addOptions(options: Record<string, string>): this { return this; }
  setValue(value: string): this { return this; }
  getValue(): string { return ''; }
  onChange(callback: (value: string) => void): this { return this; }
}

export class ButtonComponent {
  buttonEl: HTMLButtonElement = {} as HTMLButtonElement;
  setButtonText(text: string): this { return this; }
  setCta(): this { return this; }
  setWarning(): this { return this; }
  setIcon(icon: string): this { return this; }
  onClick(callback: () => void): this { return this; }
}

export class SliderComponent {
  sliderEl: HTMLInputElement = {} as HTMLInputElement;
  setValue(value: number): this { return this; }
  getValue(): number { return 0; }
  setLimits(min: number, max: number, step: number): this { return this; }
  setDynamicTooltip(): this { return this; }
  onChange(callback: (value: number) => void): this { return this; }
}

export class Notice {
  constructor(message: string, timeout?: number) {}
  hide(): void {}
}

export type { App as ObsidianApp };
