import type { App, TFile, TFolder } from 'obsidian';
import { TAbstractFile } from 'obsidian';
import type { ToolDefinition, ToolExecutionContext } from './types';

/**
 * Duck-type interfaces for RAG service compatibility.
 * obsidian-mcp ships without RAG — these allow compilation.
 * When obsidi-claude registers as a tool provider, its RAG-enhanced tools override these.
 */

export interface RAGSearchResult {
  document: {
    filepath: string;
    content: string;
    metadata: {
      title?: string;
      tags?: string[];
      headings?: string[];
      links?: string[];
      frontmatter?: Record<string, unknown>;
      hash: string;
    };
  };
  score: number;
}

export interface RAGSearchOptions {
  limit?: number;
  minScore?: number;
  filterTags?: string[];
  filterFolders?: string[];
  excludeFolders?: string[];
}

export interface RAGService {
  isConfigured(): boolean;
  search(query: string, options?: RAGSearchOptions): Promise<RAGSearchResult[]>;
}

/**
 * Creates Obsidian-specific tools that Claude can use
 */
export class ObsidianTools {
  private app: App;
  private ragService: RAGService | null;

  constructor(app: App, ragService?: RAGService) {
    this.app = app;
    this.ragService = ragService || null;
  }

  setRAGService(ragService: RAGService): void {
    this.ragService = ragService;
  }

  /**
   * Retrieves a file by path, returning either the TFile or an error object.
   * Consolidates file existence and type checking logic.
   */
  private getFileOrError(filepath: string): TFile | { error: string } {
    const file = this.app.vault.getAbstractFileByPath(filepath);
    if (!file || !('extension' in file)) {
      return { error: `File not found: ${filepath}` };
    }
    return file as TFile;
  }

  /**
   * Ensures parent folders exist for a given file path.
   * Creates any missing folders in the path hierarchy.
   */
  private async ensureParentFolder(filepath: string): Promise<void> {
    const parentPath = filepath.split('/').slice(0, -1).join('/');
    if (parentPath && !this.app.vault.getAbstractFileByPath(parentPath)) {
      await this.app.vault.createFolder(parentPath);
    }
  }

  /**
   * Wraps a handler function with standard error handling and JSON serialization.
   * Reduces boilerplate across all tool handlers.
   */
  private wrapHandler<T>(
    fn: (params: Record<string, unknown>, context?: ToolExecutionContext) => Promise<T>
  ): (params: Record<string, unknown>, context?: ToolExecutionContext) => Promise<string> {
    return async (params, context) => {
      try {
        const result = await fn(params, context);
        return JSON.stringify(result);
      } catch (error) {
        return JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }

  /**
   * Get all tool definitions
   */
  getToolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      this.getInstructionsTool(),
      this.getSemanticSearchTool(),
      this.getVaultStructureTool(),
      this.getFileMetadataTool(),
      this.getBacklinksTool(),
      this.getOutgoingLinksTool(),
      this.getTagsTool(),
      this.getSearchByTagTool(),
      this.getSuggestTagsTool(),
      this.getRecentFilesTool(),
      this.getSearchByPropertyTool(),
      this.getCreateNoteTool(),
      this.getAppendToNoteTool(),
      this.getSetFrontmatterTool(),
      this.getDailyNoteTool(),
      this.getSearchContentTool(),
      this.getOpenNoteTool(),
      this.getActiveNoteTool(),
      this.getReadNoteTool(),
      this.getListTemplatesTool(),
      this.getCreateFromTemplateTool(),
      this.getCreateCanvasTool(),
      this.getDeleteTool(),
      this.getGraphNeighborsTool(),
      this.getFindOrphansTool(),
      this.getFindBrokenLinksTool(),
      this.getSuggestLinksTool(),
      this.getRenameTool(),
      this.getDataviewQueryTool(),
    ];

    return tools;
  }

  /**
   * Semantic search using RAG
   */
  private getSemanticSearchTool(): ToolDefinition {
    return {
      name: 'semantic_search',
      description:
        'Search the vault for notes semantically similar to the query. Returns relevant chunks of text with similarity scores. Use this to find notes about a topic even if they don\'t contain exact keywords.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query describing what you\'re looking for',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: filter results to notes with these tags',
          },
          folders: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: filter results to notes in these folders',
          },
        },
        required: ['query'],
      },
      handler: this.wrapHandler(async (params) => {
        if (!this.ragService || !this.ragService.isConfigured()) {
          return { error: 'Semantic search is not configured. Enable embeddings in settings.' };
        }

        const results = await this.ragService.search(params.query as string, {
          limit: (params.limit as number) || 5,
          filterTags: params.tags as string[] | undefined,
          filterFolders: params.folders as string[] | undefined,
        });

        return {
          results: results.map((r) => ({
            filepath: r.document.filepath,
            title: r.document.metadata.title,
            score: Math.round(r.score * 100) / 100,
            excerpt: r.document.content.slice(0, 500),
            tags: r.document.metadata.tags,
          })),
        };
      }),
    };
  }

  /**
   * Get vault folder structure
   */
  private getVaultStructureTool(): ToolDefinition {
    return {
      name: 'vault_structure',
      description:
        'Get the folder structure of the vault. Use this to understand how notes are organized.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Optional: path to start from (default: root)',
          },
          depth: {
            type: 'number',
            description: 'Maximum depth to traverse (default: 3)',
          },
          includeFiles: {
            type: 'boolean',
            description: 'Include file names in output (default: false)',
          },
        },
      },
      handler: this.wrapHandler(async (params) => {
        const startPath = (params.path as string) || '';
        const maxDepth = (params.depth as number) || 3;
        const includeFiles = (params.includeFiles as boolean) || false;

        interface TreeNode {
          name: string;
          type: 'folder' | 'file';
          children?: TreeNode[];
          fileCount?: number;
        }

        const buildTree = (folder: TFolder, depth: number): TreeNode | null => {
          if (depth > maxDepth) return null;

          const children: TreeNode[] = [];
          let fileCount = 0;

          for (const child of folder.children) {
            if (child instanceof TAbstractFile) {
              if ('children' in child) {
                const subTree = buildTree(child as TFolder, depth + 1);
                if (subTree) children.push(subTree);
              } else {
                fileCount++;
                if (includeFiles && child.name.endsWith('.md')) {
                  children.push({ name: child.name, type: 'file' });
                }
              }
            }
          }

          return {
            name: folder.name || 'vault',
            type: 'folder',
            children: children.length > 0 ? children : undefined,
            fileCount: includeFiles ? undefined : fileCount,
          };
        };

        let startFolder: TFolder;
        if (startPath) {
          const abstractFile = this.app.vault.getAbstractFileByPath(startPath);
          if (!abstractFile || !('children' in abstractFile)) {
            return { error: `Folder not found: ${startPath}` };
          }
          startFolder = abstractFile as TFolder;
        } else {
          startFolder = this.app.vault.getRoot();
        }

        return buildTree(startFolder, 0);
      }),
    };
  }

  /**
   * Get file metadata
   */
  private getFileMetadataTool(): ToolDefinition {
    return {
      name: 'file_metadata',
      description:
        'Get metadata for a specific file including frontmatter, tags, headings, and links.',
      parameters: {
        type: 'object',
        properties: {
          filepath: {
            type: 'string',
            description: 'Path to the file (e.g., "folder/note.md")',
          },
        },
        required: ['filepath'],
      },
      handler: this.wrapHandler(async (params) => {
        const filepath = params.filepath as string;
        const fileResult = this.getFileOrError(filepath);
        if ('error' in fileResult) {
          return fileResult;
        }

        const tfile = fileResult;
        const cache = this.app.metadataCache.getFileCache(tfile);

        return {
          path: tfile.path,
          name: tfile.basename,
          extension: tfile.extension,
          created: new Date(tfile.stat.ctime).toISOString(),
          modified: new Date(tfile.stat.mtime).toISOString(),
          size: tfile.stat.size,
          frontmatter: cache?.frontmatter || {},
          tags: cache?.tags?.map((t) => t.tag) || [],
          headings: cache?.headings?.map((h) => ({ level: h.level, text: h.heading })) || [],
          links: cache?.links?.map((l) => l.link) || [],
          embeds: cache?.embeds?.map((e) => e.link) || [],
        };
      }),
    };
  }

  /**
   * Get backlinks to a file
   */
  private getBacklinksTool(): ToolDefinition {
    return {
      name: 'backlinks',
      description:
        'Get all notes that link TO a specific file. Useful for understanding how a note is connected in the knowledge graph.',
      parameters: {
        type: 'object',
        properties: {
          filepath: {
            type: 'string',
            description: 'Path to the file to find backlinks for',
          },
        },
        required: ['filepath'],
      },
      handler: this.wrapHandler(async (params) => {
        const filepath = params.filepath as string;
        const file = this.app.vault.getAbstractFileByPath(filepath);

        if (!file) {
          return { error: `File not found: ${filepath}` };
        }

        const backlinks: Array<{ filepath: string; title: string; linkText: string }> = [];
        const resolvedLinks = this.app.metadataCache.resolvedLinks;

        for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
          if (links[filepath]) {
            const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
            if (sourceFile && 'basename' in sourceFile) {
              const sourceCache = this.app.metadataCache.getFileCache(sourceFile as TFile);
              const title = (sourceCache?.frontmatter?.title as string) || (sourceFile as TFile).basename;
              backlinks.push({
                filepath: sourcePath,
                title,
                linkText: `[[${filepath.replace(/\.md$/, '')}]]`,
              });
            }
          }
        }

        return { file: filepath, backlinkCount: backlinks.length, backlinks };
      }),
    };
  }

  /**
   * Get outgoing links from a file
   */
  private getOutgoingLinksTool(): ToolDefinition {
    return {
      name: 'outgoing_links',
      description:
        'Get all links FROM a specific file to other notes. Shows what topics this note references.',
      parameters: {
        type: 'object',
        properties: {
          filepath: {
            type: 'string',
            description: 'Path to the file to find outgoing links for',
          },
          includeUnresolved: {
            type: 'boolean',
            description: 'Include links to notes that don\'t exist yet (default: false)',
          },
        },
        required: ['filepath'],
      },
      handler: this.wrapHandler(async (params) => {
        const filepath = params.filepath as string;
        const includeUnresolved = (params.includeUnresolved as boolean) || false;

        const fileResult = this.getFileOrError(filepath);
        if ('error' in fileResult) {
          return fileResult;
        }

        const cache = this.app.metadataCache.getFileCache(fileResult);
        const resolvedLinks = this.app.metadataCache.resolvedLinks[filepath] || {};
        const unresolvedLinks = this.app.metadataCache.unresolvedLinks[filepath] || {};

        const links: Array<{ link: string; resolved: boolean; targetPath?: string }> = [];

        for (const targetPath of Object.keys(resolvedLinks)) {
          const linkInfo = cache?.links?.find((l) => {
            const resolved = this.app.metadataCache.getFirstLinkpathDest(l.link, filepath);
            return resolved?.path === targetPath;
          });
          links.push({ link: linkInfo?.link || targetPath, resolved: true, targetPath });
        }

        if (includeUnresolved) {
          for (const link of Object.keys(unresolvedLinks)) {
            links.push({ link, resolved: false });
          }
        }

        return { file: filepath, linkCount: links.length, links };
      }),
    };
  }

  /**
   * Get all tags in the vault
   */
  private getTagsTool(): ToolDefinition {
    return {
      name: 'vault_tags',
      description:
        'Get all tags used in the vault with their usage counts. Use this to understand the tagging taxonomy.',
      parameters: {
        type: 'object',
        properties: {
          prefix: {
            type: 'string',
            description: 'Optional: filter to tags starting with this prefix (e.g., "#project")',
          },
        },
      },
      handler: this.wrapHandler(async (params) => {
        const prefix = params.prefix as string | undefined;
        const allTags = (this.app.metadataCache as unknown as { getTags(): Record<string, number> }).getTags();

        let tags = Object.entries(allTags).map(([tag, count]) => ({ tag, count }));

        if (prefix) {
          const normalizedPrefix = prefix.startsWith('#') ? prefix : '#' + prefix;
          tags = tags.filter((t) => t.tag.toLowerCase().startsWith(normalizedPrefix.toLowerCase()));
        }

        tags.sort((a, b) => b.count - a.count);
        return { totalTags: tags.length, tags: tags.slice(0, 100) };
      }),
    };
  }

  /**
   * Search notes by tag
   */
  private getSearchByTagTool(): ToolDefinition {
    return {
      name: 'search_by_tag',
      description:
        'Find all notes that have a specific tag. Searches both frontmatter tags and inline tags.',
      parameters: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            description: 'The tag to search for (with or without # prefix)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results (default: 50)',
          },
        },
        required: ['tag'],
      },
      handler: this.wrapHandler(async (params) => {
        const inputTag = params.tag as string;
        const limit = (params.limit as number) || 50;
        const normalizedTag = inputTag.startsWith('#') ? inputTag : '#' + inputTag;

        const files = this.app.vault.getMarkdownFiles();
        const matches: Array<{
          path: string;
          title: string;
          allTags: string[];
        }> = [];

        for (const file of files) {
          if (matches.length >= limit) break;
          const cache = this.app.metadataCache.getFileCache(file);
          if (!cache) continue;

          // Check inline tags (cache.tags)
          const inlineTags = cache.tags?.map((t) => t.tag.toLowerCase()) || [];
          // Check frontmatter tags
          const frontmatterTags = (cache.frontmatter?.tags as string[] | undefined)?.map(
            (t) => (t.startsWith('#') ? t : '#' + t).toLowerCase()
          ) || [];
          const allTags = [...new Set([...inlineTags, ...frontmatterTags])];

          if (allTags.includes(normalizedTag.toLowerCase())) {
            matches.push({
              path: file.path,
              title: (cache.frontmatter?.title as string) || file.basename,
              allTags: [...new Set([...(cache.tags?.map((t) => t.tag) || []), ...(cache.frontmatter?.tags as string[] || [])])],
            });
          }
        }

        return { tag: normalizedTag, matchCount: matches.length, matches };
      }),
    };
  }

  /**
   * Suggest tags for a note
   */
  private getSuggestTagsTool(): ToolDefinition {
    return {
      name: 'suggest_tags',
      description:
        'Analyze a note\'s content and suggest relevant tags based on existing vault tags and content similarity.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the note to analyze',
          },
          maxSuggestions: {
            type: 'number',
            description: 'Maximum number of tag suggestions (default: 10)',
          },
        },
        required: ['path'],
      },
      handler: this.wrapHandler(async (params) => {
        const path = params.path as string;
        const maxSuggestions = (params.maxSuggestions as number) || 10;

        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file || !(file instanceof TFile)) {
          throw new Error(`File not found: ${path}`);
        }

        const content = await this.app.vault.read(file);
        const cache = this.app.metadataCache.getFileCache(file);
        const existingTags = new Set(cache?.tags?.map((t) => t.tag.toLowerCase()) || []);

        // Get all vault tags
        const allTags = (this.app.metadataCache as unknown as { getTags(): Record<string, number> }).getTags();

        // Score tags based on content matches
        const suggestions: Array<{ tag: string; score: number; reason: string }> = [];
        const contentLower = content.toLowerCase();

        for (const [tag, count] of Object.entries(allTags)) {
          if (existingTags.has(tag.toLowerCase())) continue;

          // Extract tag name without #
          const tagName = tag.slice(1).toLowerCase();
          const parts = tagName.split('/');

          // Check if any part of the tag (including nested parts) appears in content
          let score = 0;
          let reason = '';

          for (const part of parts) {
            if (part.length > 2 && contentLower.includes(part)) {
              score += 2;
              reason = `"${part}" mentioned in content`;
            }
          }

          // Boost popular tags slightly
          if (count > 5) {
            score += 1;
            if (!reason) reason = `commonly used (${count} notes)`;
          }

          if (score > 0) {
            suggestions.push({ tag, score, reason });
          }
        }

        // Sort by score and return top suggestions
        suggestions.sort((a, b) => b.score - a.score);
        return {
          path,
          existingTags: Array.from(existingTags),
          suggestions: suggestions.slice(0, maxSuggestions),
        };
      }),
    };
  }

  /**
   * Get recently modified files
   */
  private getRecentFilesTool(): ToolDefinition {
    return {
      name: 'recent_files',
      description:
        'Get recently modified or created files. Useful for understanding what the user has been working on.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of files to return (default: 10)',
          },
          sortBy: {
            type: 'string',
            enum: ['modified', 'created'],
            description: 'Sort by modification time or creation time (default: modified)',
          },
          folder: {
            type: 'string',
            description: 'Optional: limit to files in this folder',
          },
        },
      },
      handler: this.wrapHandler(async (params) => {
        const limit = (params.limit as number) || 10;
        const sortBy = (params.sortBy as string) || 'modified';
        const folder = params.folder as string | undefined;

        let files = this.app.vault.getMarkdownFiles();
        if (folder) {
          files = files.filter((f) => f.path.startsWith(folder + '/'));
        }

        const sorted = files.sort((a, b) => {
          const timeA = sortBy === 'created' ? a.stat.ctime : a.stat.mtime;
          const timeB = sortBy === 'created' ? b.stat.ctime : b.stat.mtime;
          return timeB - timeA;
        });

        return {
          files: sorted.slice(0, limit).map((file) => {
            const cache = this.app.metadataCache.getFileCache(file);
            return {
              path: file.path,
              name: file.basename,
              modified: new Date(file.stat.mtime).toISOString(),
              created: new Date(file.stat.ctime).toISOString(),
              title: (cache?.frontmatter?.title as string) || file.basename,
              tags: cache?.tags?.map((t) => t.tag) || [],
            };
          }),
        };
      }),
    };
  }

  /**
   * Search notes by frontmatter property
   */
  private getSearchByPropertyTool(): ToolDefinition {
    return {
      name: 'search_by_property',
      description:
        'Find notes that have a specific frontmatter property with a given value. Useful for finding notes by status, type, project, etc.',
      parameters: {
        type: 'object',
        properties: {
          property: {
            type: 'string',
            description: 'The frontmatter property name to search (e.g., "status", "type", "project")',
          },
          value: {
            type: 'string',
            description: 'The value to match (case-insensitive partial match)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results (default: 20)',
          },
        },
        required: ['property'],
      },
      handler: this.wrapHandler(async (params) => {
        const property = params.property as string;
        const value = (params.value as string | undefined)?.toLowerCase();
        const limit = (params.limit as number) || 20;

        const files = this.app.vault.getMarkdownFiles();
        const matches: Array<{ path: string; title: string; propertyValue: unknown }> = [];

        for (const file of files) {
          if (matches.length >= limit) break;
          const cache = this.app.metadataCache.getFileCache(file);
          const frontmatter = cache?.frontmatter;
          if (!frontmatter || !(property in frontmatter)) continue;

          const propValue = frontmatter[property];
          if (value && !String(propValue).toLowerCase().includes(value)) continue;

          matches.push({
            path: file.path,
            title: (frontmatter.title as string) || file.basename,
            propertyValue: propValue,
          });
        }

        return { property, searchValue: value, matchCount: matches.length, matches };
      }),
    };
  }

  /**
   * Create a new note
   */
  private getCreateNoteTool(): ToolDefinition {
    return {
      name: 'create_note',
      description:
        'Create a new note in the vault. Returns the path of the created note.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path for the new note (e.g., "folder/note-name.md")',
          },
          content: {
            type: 'string',
            description: 'Content for the note (markdown)',
          },
          overwrite: {
            type: 'boolean',
            description: 'Overwrite if file exists (default: false)',
          },
        },
        required: ['path', 'content'],
      },
      handler: this.wrapHandler(async (params) => {
        const filepath = params.path as string;
        const content = params.content as string;
        const overwrite = (params.overwrite as boolean) || false;

        const existing = this.app.vault.getAbstractFileByPath(filepath);
        if (existing && !overwrite) {
          return { error: `File already exists: ${filepath}. Use overwrite: true to replace.` };
        }

        if (existing && overwrite) {
          await this.app.vault.modify(existing as TFile, content);
        } else {
          await this.ensureParentFolder(filepath);
          await this.app.vault.create(filepath, content);
        }

        // Read-back verification: confirm the write actually persisted
        const written = this.app.vault.getAbstractFileByPath(filepath);
        if (!written || !(written instanceof TFile)) {
          return { error: `Write verification failed: file not found after write at ${filepath}` };
        }
        const verified = await this.app.vault.cachedRead(written);
        const contentLength = content.length;
        const verifiedLength = verified.length;

        if (verifiedLength !== contentLength) {
          return {
            error: `Write verification failed: expected ${contentLength} chars, got ${verifiedLength}`,
            path: filepath,
            contentLength,
            verifiedLength,
          };
        }

        return {
          success: true,
          path: filepath,
          message: overwrite && existing ? 'File overwritten' : 'File created',
          contentLength,
          verified: true,
        };
      }),
    };
  }

  /**
   * Append content to an existing note
   */
  private getAppendToNoteTool(): ToolDefinition {
    return {
      name: 'append_to_note',
      description:
        'Append content to the end of an existing note. Optionally add under a specific heading.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the note',
          },
          content: {
            type: 'string',
            description: 'Content to append',
          },
          heading: {
            type: 'string',
            description: 'Optional: heading to append under (creates if not exists)',
          },
          createIfMissing: {
            type: 'boolean',
            description: 'Create the note if it doesn\'t exist (default: false)',
          },
        },
        required: ['path', 'content'],
      },
      handler: this.wrapHandler(async (params) => {
        const filepath = params.path as string;
        const content = params.content as string;
        const heading = params.heading as string | undefined;
        const createIfMissing = (params.createIfMissing as boolean) || false;

        const file = this.app.vault.getAbstractFileByPath(filepath);

        if (!file) {
          if (createIfMissing) {
            await this.ensureParentFolder(filepath);
            const initialContent = heading ? `# ${heading}\n\n${content}` : content;
            await this.app.vault.create(filepath, initialContent);

            const created = this.app.vault.getAbstractFileByPath(filepath);
            if (!created || !(created instanceof TFile)) {
              return { error: `Write verification failed: file not found after create at ${filepath}` };
            }
            const verified = await this.app.vault.cachedRead(created);
            return {
              success: true,
              path: filepath,
              created: true,
              contentLength: initialContent.length,
              verifiedLength: verified.length,
              verified: verified.length === initialContent.length,
            };
          }
          return { error: `File not found: ${filepath}` };
        }

        if (!(file instanceof TAbstractFile) || !('extension' in file)) {
          return { error: `Not a file: ${filepath}` };
        }

        const tfile = file as TFile;
        let existingContent = await this.app.vault.read(tfile);
        const previousLength = existingContent.length;

        if (heading) {
          const headingPattern = new RegExp(
            `^(#{1,6})\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
            'm'
          );
          const match = existingContent.match(headingPattern);

          if (match) {
            const headingLevel = match[1].length;
            const insertPos = match.index! + match[0].length;
            const afterHeading = existingContent.slice(insertPos);
            const nextHeadingMatch = afterHeading.match(new RegExp(`^#{1,${headingLevel}}\\s+`, 'm'));

            if (nextHeadingMatch) {
              const insertAt = insertPos + nextHeadingMatch.index!;
              existingContent = existingContent.slice(0, insertAt) + '\n' + content + '\n\n' + existingContent.slice(insertAt);
            } else {
              existingContent += '\n\n' + content;
            }
          } else {
            existingContent += `\n\n## ${heading}\n\n${content}`;
          }
        } else {
          existingContent += '\n\n' + content;
        }

        const expectedLength = existingContent.length;
        await this.app.vault.modify(tfile, existingContent);

        // Read-back verification
        const verified = await this.app.vault.cachedRead(tfile);
        const verifiedLength = verified.length;

        if (verifiedLength !== expectedLength) {
          return {
            error: `Write verification failed: expected ${expectedLength} chars, got ${verifiedLength}`,
            path: filepath,
            expectedLength,
            verifiedLength,
          };
        }

        return {
          success: true,
          path: filepath,
          previousLength,
          contentLength: expectedLength,
          appendedLength: content.length,
          verified: true,
        };
      }),
    };
  }

  /**
   * Set frontmatter properties on a note
   */
  private getSetFrontmatterTool(): ToolDefinition {
    return {
      name: 'set_frontmatter',
      description:
        'Set or update frontmatter (YAML metadata) properties on a note. Properties can be added, updated, or removed.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the note',
          },
          properties: {
            type: 'object',
            description: 'Properties to set. Set a property to null to remove it.',
          },
          merge: {
            type: 'boolean',
            description: 'Merge with existing frontmatter (default: true). If false, replaces all frontmatter.',
          },
        },
        required: ['path', 'properties'],
      },
      handler: this.wrapHandler(async (params) => {
        const filepath = params.path as string;
        const newProps = params.properties as Record<string, unknown>;
        const merge = params.merge !== false;

        const fileResult = this.getFileOrError(filepath);
        if ('error' in fileResult) {
          return fileResult;
        }

        const tfile = fileResult;
        let content = await this.app.vault.read(tfile);

        // Parse existing frontmatter
        const frontmatterRegex = /^---\n([\s\S]*?)\n---\n?/;
        const match = content.match(frontmatterRegex);
        let existingProps: Record<string, unknown> = {};
        let bodyContent = content;

        if (match) {
          // Parse existing YAML frontmatter
          const yamlContent = match[1];
          bodyContent = content.slice(match[0].length);

          // Simple YAML parsing for common cases
          for (const line of yamlContent.split('\n')) {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
              const key = line.slice(0, colonIdx).trim();
              let value: unknown = line.slice(colonIdx + 1).trim();

              // Parse value types
              if (value === 'true') value = true;
              else if (value === 'false') value = false;
              else if (value === 'null' || value === '') value = null;
              else if (!isNaN(Number(value)) && value !== '') value = Number(value);
              else if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
                // Simple array parsing: [item1, item2]
                value = value.slice(1, -1).split(',').map(s => s.trim()).filter(s => s);
              } else if (typeof value === 'string' && (value.startsWith('"') || value.startsWith("'"))) {
                value = value.slice(1, -1);
              }

              existingProps[key] = value;
            }
          }
        }

        // Merge or replace properties
        const finalProps = merge ? { ...existingProps } : {};
        for (const [key, value] of Object.entries(newProps)) {
          if (value === null) {
            delete finalProps[key];
          } else {
            finalProps[key] = value;
          }
        }

        // Build new frontmatter YAML
        const yamlLines: string[] = [];
        for (const [key, value] of Object.entries(finalProps)) {
          if (Array.isArray(value)) {
            yamlLines.push(`${key}: [${value.join(', ')}]`);
          } else if (typeof value === 'string' && (value.includes(':') || value.includes('#') || value.includes('\n'))) {
            yamlLines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
          } else {
            yamlLines.push(`${key}: ${value}`);
          }
        }

        // Reconstruct file content
        const newFrontmatter = yamlLines.length > 0
          ? `---\n${yamlLines.join('\n')}\n---\n`
          : '';
        const newContent = newFrontmatter + bodyContent;

        const expectedLength = newContent.length;
        await this.app.vault.modify(tfile, newContent);

        // Read-back verification
        const verified = await this.app.vault.cachedRead(tfile);
        const verifiedLength = verified.length;

        if (verifiedLength !== expectedLength) {
          return {
            error: `Write verification failed: expected ${expectedLength} chars, got ${verifiedLength}`,
            path: filepath,
            expectedLength,
            verifiedLength,
          };
        }

        return {
          success: true,
          path: filepath,
          frontmatter: finalProps,
          contentLength: expectedLength,
          verified: true,
        };
      }),
    };
  }

  /**
   * Get or create today's daily note
   */
  private getDailyNoteTool(): ToolDefinition {
    return {
      name: 'daily_note',
      description:
        'Get today\'s daily note path and content. Creates it if it doesn\'t exist using the configured daily note format.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Optional: specific date in YYYY-MM-DD format (default: today)',
          },
          create: {
            type: 'boolean',
            description: 'Create if doesn\'t exist (default: true)',
          },
        },
      },
      handler: this.wrapHandler(async (params) => {
        const dateStr = (params.date as string) || new Date().toISOString().split('T')[0];
        const shouldCreate = params.create !== false;

        const date = new Date(dateStr);
        if (isNaN(date.getTime())) {
          return { error: `Invalid date: ${dateStr}` };
        }

        const filename = `${dateStr}.md`;
        const possiblePaths = [
          filename,
          `Daily/${filename}`,
          `daily/${filename}`,
          `Daily Notes/${filename}`,
          `Journals/${filename}`,
          `journal/${filename}`,
        ];

        for (const path of possiblePaths) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file && 'extension' in file) {
            const content = await this.app.vault.cachedRead(file as TFile);
            return {
              path,
              exists: true,
              content: content.slice(0, 2000),
              truncated: content.length > 2000,
            };
          }
        }

        if (!shouldCreate) {
          return { exists: false, message: `No daily note found for ${dateStr}`, searchedPaths: possiblePaths };
        }

        let createPath = filename;
        for (const path of possiblePaths) {
          const folder = path.split('/').slice(0, -1).join('/');
          if (!folder || this.app.vault.getAbstractFileByPath(folder)) {
            createPath = path;
            break;
          }
        }

        const template = `# ${date.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })}\n\n`;

        await this.ensureParentFolder(createPath);
        await this.app.vault.create(createPath, template);

        // Read-back verification
        const written = this.app.vault.getAbstractFileByPath(createPath);
        if (!written || !(written instanceof TFile)) {
          return { error: `Write verification failed: file not found after create at ${createPath}` };
        }
        const verified = await this.app.vault.cachedRead(written);

        return {
          path: createPath,
          exists: false,
          created: true,
          content: template,
          contentLength: template.length,
          verifiedLength: verified.length,
          verified: verified.length === template.length,
        };
      }),
    };
  }

  /**
   * Full-text search (keyword-based)
   */
  private getSearchContentTool(): ToolDefinition {
    return {
      name: 'search_content',
      description:
        'Search for text across all notes (keyword/regex search). Complements semantic_search for exact matches.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (supports regex)',
          },
          caseSensitive: {
            type: 'boolean',
            description: 'Case-sensitive search (default: false)',
          },
          limit: {
            type: 'number',
            description: 'Maximum results (default: 20)',
          },
          folder: {
            type: 'string',
            description: 'Optional: limit search to folder',
          },
        },
        required: ['query'],
      },
      handler: this.wrapHandler(async (params) => {
        const query = params.query as string;
        const caseSensitive = (params.caseSensitive as boolean) || false;
        const limit = (params.limit as number) || 20;
        const folder = params.folder as string | undefined;

        const flags = caseSensitive ? 'g' : 'gi';
        let regex: RegExp;
        try {
          regex = new RegExp(query, flags);
        } catch {
          regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
        }

        const files = this.app.vault.getMarkdownFiles();
        const results: Array<{ path: string; title: string; matches: Array<{ line: number; text: string }>; matchCount: number }> = [];

        for (const file of files) {
          if (results.length >= limit) break;
          if (folder && !file.path.startsWith(folder + '/')) continue;

          const content = await this.app.vault.cachedRead(file);
          const lines = content.split('\n');
          const matches: Array<{ line: number; text: string }> = [];

          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push({ line: i + 1, text: lines[i].slice(0, 200) });
              if (matches.length >= 5) break;
            }
            regex.lastIndex = 0;
          }

          if (matches.length > 0) {
            const cache = this.app.metadataCache.getFileCache(file);
            results.push({
              path: file.path,
              title: (cache?.frontmatter?.title as string) || file.basename,
              matches,
              matchCount: (content.match(regex) || []).length,
            });
          }
        }

        return { query, resultCount: results.length, results };
      }),
    };
  }

  /**
   * Open a note in the editor
   */
  private getOpenNoteTool(): ToolDefinition {
    return {
      name: 'open_note',
      description: 'Open a note in the Obsidian editor for the user to view/edit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the note to open' },
          newLeaf: { type: 'boolean', description: 'Open in new pane (default: false)' },
          line: { type: 'number', description: 'Optional: scroll to specific line' },
        },
        required: ['path'],
      },
      handler: this.wrapHandler(async (params) => {
        const filepath = params.path as string;
        const newLeaf = (params.newLeaf as boolean) || false;
        const line = params.line as number | undefined;

        const fileResult = this.getFileOrError(filepath);
        if ('error' in fileResult) {
          return fileResult;
        }

        const leaf = this.app.workspace.getLeaf(newLeaf);
        await leaf.openFile(fileResult);

        if (line !== undefined) {
          setTimeout(() => {
            const view = this.app.workspace.getActiveViewOfType(
              this.app.workspace.activeLeaf?.view?.constructor as unknown as new () => unknown
            );
            if (view && 'editor' in (view as Record<string, unknown>)) {
              const editor = (view as Record<string, unknown>).editor as {
                setCursor: (pos: { line: number; ch: number }) => void;
                scrollIntoView: (range: { from: { line: number }; to: { line: number } }) => void;
              };
              editor.setCursor({ line: line - 1, ch: 0 });
              editor.scrollIntoView({ from: { line: line - 1 }, to: { line: line - 1 } });
            }
          }, 100);
        }

        return { success: true, path: filepath, opened: true };
      }),
    };
  }

  /**
   * Get the currently active note
   */
  private getActiveNoteTool(): ToolDefinition {
    return {
      name: 'active_note',
      description: 'Get information about the currently open/active note including its content.',
      parameters: {
        type: 'object',
        properties: {
          includeContent: { type: 'boolean', description: 'Include full note content (default: true)' },
          maxContentLength: { type: 'number', description: 'Max content length to return (default: 5000)' },
        },
      },
      handler: this.wrapHandler(async (params) => {
        const includeContent = params.includeContent !== false;
        const maxLength = (params.maxContentLength as number) || 5000;

        const file = this.app.workspace.getActiveFile();
        if (!file) {
          return { active: false, message: 'No file is currently open' };
        }

        const cache = this.app.metadataCache.getFileCache(file);
        const result: Record<string, unknown> = {
          active: true,
          path: file.path,
          name: file.basename,
          extension: file.extension,
          modified: new Date(file.stat.mtime).toISOString(),
          created: new Date(file.stat.ctime).toISOString(),
          frontmatter: cache?.frontmatter || {},
          tags: cache?.tags?.map((t) => t.tag) || [],
          headings: cache?.headings?.map((h) => ({ level: h.level, text: h.heading })) || [],
          links: cache?.links?.map((l) => l.link) || [],
        };

        if (includeContent) {
          const content = await this.app.vault.cachedRead(file);
          result.content = content.slice(0, maxLength);
          result.truncated = content.length > maxLength;
          result.totalLength = content.length;
        }

        return result;
      }),
    };
  }

  /**
   * Read the full content of a note
   */
  private getReadNoteTool(): ToolDefinition {
    return {
      name: 'read_note',
      description: 'Read the full content of a note. Use this when you need the actual text content of a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the note to read' },
          maxLength: { type: 'number', description: 'Maximum content length to return (default: 10000)' },
        },
        required: ['path'],
      },
      handler: this.wrapHandler(async (params) => {
        const filepath = params.path as string;
        const maxLength = (params.maxLength as number) || 10000;

        const fileResult = this.getFileOrError(filepath);
        if ('error' in fileResult) {
          return fileResult;
        }

        const content = await this.app.vault.cachedRead(fileResult);
        return {
          path: filepath,
          content: content.slice(0, maxLength),
          truncated: content.length > maxLength,
          totalLength: content.length,
        };
      }),
    };
  }

  /**
   * List available templates
   */
  private getListTemplatesTool(): ToolDefinition {
    return {
      name: 'list_templates',
      description: 'List available templates in the vault. Templates are typically markdown files in a Templates folder.',
      parameters: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: 'Template folder path (default: searches common locations like "Templates", "templates", "_templates")',
          },
        },
      },
      handler: this.wrapHandler(async (params) => {
        const customFolder = params.folder as string | undefined;

        // Common template folder locations
        const templateFolders = customFolder
          ? [customFolder]
          : ['Templates', 'templates', '_templates', '.templates', 'template', 'Vorlagen'];

        const templates: Array<{ name: string; path: string; preview: string }> = [];

        for (const folderPath of templateFolders) {
          const folder = this.app.vault.getAbstractFileByPath(folderPath);
          if (folder && 'children' in folder) {
            for (const file of (folder as TFolder).children) {
              if (file instanceof TFile && file.extension === 'md') {
                const content = await this.app.vault.cachedRead(file);
                templates.push({
                  name: file.basename,
                  path: file.path,
                  preview: content.slice(0, 200).replace(/\n/g, ' ').trim() + (content.length > 200 ? '...' : ''),
                });
              }
            }
          }
        }

        if (templates.length === 0) {
          return {
            templates: [],
            message: 'No templates found. Check if you have a Templates folder in your vault.',
            searchedFolders: templateFolders,
          };
        }

        return { templates, count: templates.length };
      }),
    };
  }

  /**
   * Create a note from a template
   */
  private getCreateFromTemplateTool(): ToolDefinition {
    return {
      name: 'create_from_template',
      description: 'Create a new note from a template. Supports basic variable substitution like {{title}}, {{date}}, {{time}}.',
      parameters: {
        type: 'object',
        properties: {
          template: {
            type: 'string',
            description: 'Path to the template file, or template name (will search in template folders)',
          },
          path: {
            type: 'string',
            description: 'Path for the new note (e.g., "Projects/my-project.md")',
          },
          title: {
            type: 'string',
            description: 'Title for the note (used in {{title}} substitution)',
          },
          variables: {
            type: 'object',
            description: 'Additional variables for substitution (e.g., { "project": "MyProject" } replaces {{project}})',
          },
        },
        required: ['template', 'path'],
      },
      handler: this.wrapHandler(async (params) => {
        const templatePath = params.template as string;
        const targetPath = params.path as string;
        const title = (params.title as string) || targetPath.split('/').pop()?.replace('.md', '') || 'Untitled';
        const variables = (params.variables as Record<string, string>) || {};

        // Find the template file
        let templateFile = this.app.vault.getAbstractFileByPath(templatePath);

        // If not found by path, search in template folders
        if (!templateFile || !(templateFile instanceof TFile)) {
          const templateFolders = ['Templates', 'templates', '_templates', '.templates'];
          for (const folder of templateFolders) {
            const tryPath = `${folder}/${templatePath}${templatePath.endsWith('.md') ? '' : '.md'}`;
            templateFile = this.app.vault.getAbstractFileByPath(tryPath);
            if (templateFile instanceof TFile) break;
          }
        }

        if (!templateFile || !(templateFile instanceof TFile)) {
          return { error: `Template not found: ${templatePath}` };
        }

        // Check target doesn't exist
        if (this.app.vault.getAbstractFileByPath(targetPath)) {
          return { error: `File already exists: ${targetPath}` };
        }

        // Read template content
        let content = await this.app.vault.read(templateFile);

        // Build substitution map
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const fullDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        const substitutions: Record<string, string> = {
          title,
          date: dateStr,
          time: timeStr,
          datetime: `${dateStr} ${timeStr}`,
          fulldate: fullDate,
          year: String(now.getFullYear()),
          month: String(now.getMonth() + 1).padStart(2, '0'),
          day: String(now.getDate()).padStart(2, '0'),
          ...variables,
        };

        // Replace {{variable}} patterns
        content = content.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
          return substitutions[varName.toLowerCase()] ?? match;
        });

        // Create the note
        await this.ensureParentFolder(targetPath);
        await this.app.vault.create(targetPath, content);

        // Read-back verification
        const written = this.app.vault.getAbstractFileByPath(targetPath);
        if (!written || !(written instanceof TFile)) {
          return { error: `Write verification failed: file not found after create at ${targetPath}` };
        }
        const verified = await this.app.vault.cachedRead(written);
        const contentLength = content.length;
        const verifiedLength = verified.length;

        if (verifiedLength !== contentLength) {
          return {
            error: `Write verification failed: expected ${contentLength} chars, got ${verifiedLength}`,
            path: targetPath,
            contentLength,
            verifiedLength,
          };
        }

        return {
          success: true,
          path: targetPath,
          template: templateFile.path,
          substitutionsApplied: Object.keys(substitutions),
          contentLength,
          verified: true,
        };
      }),
    };
  }

  /**
   * Create a canvas file
   */
  private getCreateCanvasTool(): ToolDefinition {
    return {
      name: 'create_canvas',
      description: 'Create an Obsidian Canvas file with nodes and connections. Canvases are visual workspaces for organizing ideas.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path for the canvas file (e.g., "Canvases/my-canvas.canvas")',
          },
          nodes: {
            type: 'array',
            description: 'Array of nodes to add. Each node needs: id, type ("text"|"file"|"link"), content (text/file path/url)',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique node ID' },
                type: { type: 'string', description: '"text", "file", or "link"' },
                content: { type: 'string', description: 'Text content, file path, or URL depending on type' },
                x: { type: 'number', description: 'X position (default: auto-arranged)' },
                y: { type: 'number', description: 'Y position (default: auto-arranged)' },
                width: { type: 'number', description: 'Node width (default: 250)' },
                height: { type: 'number', description: 'Node height (default: 100 for text, 60 for links)' },
                color: { type: 'string', description: 'Node color: "1"-"6" or hex color' },
              },
            },
          },
          edges: {
            type: 'array',
            description: 'Array of edges connecting nodes. Each edge needs: fromNode, toNode (node IDs)',
            items: {
              type: 'object',
              properties: {
                fromNode: { type: 'string', description: 'Source node ID' },
                toNode: { type: 'string', description: 'Target node ID' },
                fromSide: { type: 'string', description: '"top", "bottom", "left", "right" (default: auto)' },
                toSide: { type: 'string', description: '"top", "bottom", "left", "right" (default: auto)' },
                label: { type: 'string', description: 'Edge label' },
              },
            },
          },
        },
        required: ['path', 'nodes'],
      },
      handler: this.wrapHandler(async (params) => {
        let filepath = params.path as string;
        if (!filepath.endsWith('.canvas')) {
          filepath += '.canvas';
        }

        const inputNodes = (params.nodes as Array<{
          id: string;
          type: string;
          content: string;
          x?: number;
          y?: number;
          width?: number;
          height?: number;
          color?: string;
        }>) || [];

        const inputEdges = (params.edges as Array<{
          fromNode: string;
          toNode: string;
          fromSide?: string;
          toSide?: string;
          label?: string;
        }>) || [];

        if (this.app.vault.getAbstractFileByPath(filepath)) {
          return { error: `Canvas already exists: ${filepath}` };
        }

        // Auto-arrange nodes if positions not specified
        const spacing = 300;
        const nodesPerRow = 4;

        interface CanvasNode {
          id: string;
          type: 'text' | 'file' | 'link';
          x: number;
          y: number;
          width: number;
          height: number;
          text?: string;
          file?: string;
          url?: string;
          color?: string;
        }

        const canvasNodes: CanvasNode[] = inputNodes.map((node, index) => {
          const row = Math.floor(index / nodesPerRow);
          const col = index % nodesPerRow;
          const defaultWidth = 250;
          const defaultHeight = node.type === 'text' ? 100 : 60;

          const baseNode: CanvasNode = {
            id: node.id || `node-${index}`,
            type: (node.type as 'text' | 'file' | 'link') || 'text',
            x: node.x ?? col * spacing,
            y: node.y ?? row * spacing,
            width: node.width ?? defaultWidth,
            height: node.height ?? defaultHeight,
          };

          if (node.color) {
            baseNode.color = node.color;
          }

          if (node.type === 'file') {
            baseNode.file = node.content;
          } else if (node.type === 'link') {
            baseNode.url = node.content;
          } else {
            baseNode.text = node.content;
          }

          return baseNode;
        });

        interface CanvasEdge {
          id: string;
          fromNode: string;
          fromSide: string;
          toNode: string;
          toSide: string;
          label?: string;
        }

        const canvasEdges: CanvasEdge[] = inputEdges.map((edge, index) => {
          const edgeObj: CanvasEdge = {
            id: `edge-${index}`,
            fromNode: edge.fromNode,
            fromSide: edge.fromSide || 'right',
            toNode: edge.toNode,
            toSide: edge.toSide || 'left',
          };
          if (edge.label) {
            edgeObj.label = edge.label;
          }
          return edgeObj;
        });

        const canvasData = {
          nodes: canvasNodes,
          edges: canvasEdges,
        };

        const canvasContent = JSON.stringify(canvasData, null, 2);
        await this.ensureParentFolder(filepath);
        await this.app.vault.create(filepath, canvasContent);

        // Read-back verification
        const written = this.app.vault.getAbstractFileByPath(filepath);
        if (!written || !(written instanceof TFile)) {
          return { error: `Write verification failed: file not found after create at ${filepath}` };
        }
        const verified = await this.app.vault.cachedRead(written);
        const contentLength = canvasContent.length;
        const verifiedLength = verified.length;

        if (verifiedLength !== contentLength) {
          return {
            error: `Write verification failed: expected ${contentLength} chars, got ${verifiedLength}`,
            path: filepath,
            contentLength,
            verifiedLength,
          };
        }

        return {
          success: true,
          path: filepath,
          nodeCount: canvasNodes.length,
          edgeCount: canvasEdges.length,
          contentLength,
          verified: true,
        };
      }),
    };
  }

  /**
   * Delete a file or folder
   */
  private getDeleteTool(): ToolDefinition {
    return {
      name: 'delete',
      description: 'Delete a file or folder from the vault. Moves to system trash by default.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file or folder to delete' },
          permanent: { type: 'boolean', description: 'Permanently delete instead of moving to trash (default: false)' },
        },
        required: ['path'],
      },
      handler: this.wrapHandler(async (params, context) => {
        const filepath = params.path as string;
        const permanent = (params.permanent as boolean) || false;

        const item = this.app.vault.getAbstractFileByPath(filepath);
        if (!item) {
          return { error: `Path not found: ${filepath}` };
        }

        const isFolder = 'children' in item;

        // Elicit confirmation from user if MCP context is available
        if (context?.elicitInput) {
          const confirmation = await context.elicitInput({
            mode: 'form',
            message: `Confirm ${permanent ? 'permanent deletion' : 'trash'} of ${isFolder ? 'folder' : 'file'}: ${filepath}`,
            requestedSchema: {
              type: 'object',
              properties: {
                confirm: {
                  type: 'boolean',
                  title: 'Confirm deletion',
                  description: `${permanent ? 'Permanently delete' : 'Move to trash'}: ${filepath}`,
                },
              },
              required: ['confirm'],
            },
          });

          if (confirmation.action !== 'accept' || !confirmation.content?.confirm) {
            return { cancelled: true, path: filepath, message: 'Deletion cancelled by user' };
          }
        }

        if (permanent) {
          await this.app.vault.delete(item, true);
        } else {
          await this.app.vault.trash(item, false);
        }

        // Verify deletion: file should no longer exist at original path
        const stillExists = this.app.vault.getAbstractFileByPath(filepath);
        if (stillExists) {
          return {
            error: `Delete verification failed: ${filepath} still exists after ${permanent ? 'delete' : 'trash'}`,
            path: filepath,
          };
        }

        return {
          success: true,
          path: filepath,
          type: isFolder ? 'folder' : 'file',
          method: permanent ? 'deleted' : 'trashed',
          verified: true,
        };
      }),
    };
  }

  /**
   * Get graph neighbors (directly connected notes)
   */
  private getGraphNeighborsTool(): ToolDefinition {
    return {
      name: 'graph_neighbors',
      description:
        'Get notes that are directly connected to a given note (both inbound and outbound links). Useful for exploring the knowledge graph.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the note',
          },
          depth: {
            type: 'number',
            description: 'Depth of connections to explore (default: 1, max: 2)',
          },
        },
        required: ['path'],
      },
      handler: this.wrapHandler(async (params) => {
        const filepath = params.path as string;
        const maxDepth = Math.min((params.depth as number) || 1, 2);

        const file = this.app.vault.getAbstractFileByPath(filepath);
        if (!file) {
          return { error: `File not found: ${filepath}` };
        }

        const resolvedLinks = this.app.metadataCache.resolvedLinks;
        const visited = new Set<string>();
        const neighbors: Array<{ path: string; title: string; direction: 'outgoing' | 'incoming'; depth: number }> = [];

        const explore = (currentPath: string, currentDepth: number) => {
          if (currentDepth > maxDepth || visited.has(currentPath)) return;
          visited.add(currentPath);

          const outgoing = resolvedLinks[currentPath] || {};
          for (const targetPath of Object.keys(outgoing)) {
            if (!visited.has(targetPath)) {
              const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
              if (targetFile && 'basename' in targetFile) {
                const cache = this.app.metadataCache.getFileCache(targetFile as TFile);
                neighbors.push({
                  path: targetPath,
                  title: (cache?.frontmatter?.title as string) || (targetFile as TFile).basename,
                  direction: 'outgoing',
                  depth: currentDepth,
                });
                if (currentDepth < maxDepth) explore(targetPath, currentDepth + 1);
              }
            }
          }

          for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
            if (links[currentPath] && !visited.has(sourcePath)) {
              const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
              if (sourceFile && 'basename' in sourceFile) {
                const cache = this.app.metadataCache.getFileCache(sourceFile as TFile);
                neighbors.push({
                  path: sourcePath,
                  title: (cache?.frontmatter?.title as string) || (sourceFile as TFile).basename,
                  direction: 'incoming',
                  depth: currentDepth,
                });
                if (currentDepth < maxDepth) explore(sourcePath, currentDepth + 1);
              }
            }
          }
        };

        explore(filepath, 1);
        return { centerNote: filepath, depth: maxDepth, neighborCount: neighbors.length, neighbors };
      }),
    };
  }

  /**
   * Find orphan notes (notes with no incoming or outgoing links)
   */
  private getFindOrphansTool(): ToolDefinition {
    return {
      name: 'find_orphan_notes',
      description:
        'Find notes that have no incoming or outgoing links. Orphan notes are isolated in the knowledge graph and may need connections.',
      parameters: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: 'Optional folder to search in. If not provided, searches entire vault.',
          },
          includeOutgoingOnly: {
            type: 'boolean',
            description: 'If true, includes notes that only have outgoing links but no incoming links.',
          },
        },
      },
      handler: this.wrapHandler(async (params) => {
        const folder = params.folder as string | undefined;
        const includeOutgoingOnly = params.includeOutgoingOnly as boolean || false;

        const resolvedLinks = this.app.metadataCache.resolvedLinks;
        const files = this.app.vault.getMarkdownFiles();

        // Build reverse lookup for incoming links
        const incomingLinks = new Map<string, string[]>();
        for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
          for (const targetPath of Object.keys(targets)) {
            if (!incomingLinks.has(targetPath)) {
              incomingLinks.set(targetPath, []);
            }
            incomingLinks.get(targetPath)!.push(sourcePath);
          }
        }

        const orphans: Array<{
          path: string;
          title: string;
          hasOutgoing: boolean;
          hasIncoming: boolean;
          modified: number;
        }> = [];

        for (const file of files) {
          // Filter by folder if specified
          if (folder && !file.path.startsWith(folder)) continue;

          const outgoing = resolvedLinks[file.path];
          const hasOutgoing = outgoing && Object.keys(outgoing).length > 0;
          const hasIncoming = incomingLinks.has(file.path);

          // True orphan: no links in either direction
          const isTrueOrphan = !hasOutgoing && !hasIncoming;
          // Outgoing-only orphan: has outgoing but no incoming (sink node)
          const isOutgoingOnlyOrphan = hasOutgoing && !hasIncoming;

          if (isTrueOrphan || (includeOutgoingOnly && isOutgoingOnlyOrphan)) {
            const cache = this.app.metadataCache.getFileCache(file);
            orphans.push({
              path: file.path,
              title: (cache?.frontmatter?.title as string) || file.basename,
              hasOutgoing,
              hasIncoming,
              modified: file.stat.mtime,
            });
          }
        }

        // Sort by modification date (most recent first)
        orphans.sort((a, b) => b.modified - a.modified);

        return {
          count: orphans.length,
          folder: folder || '(entire vault)',
          includeOutgoingOnly,
          orphans: orphans.slice(0, 100), // Limit results
        };
      }),
    };
  }

  /**
   * Find broken links (links to non-existent notes)
   */
  private getFindBrokenLinksTool(): ToolDefinition {
    return {
      name: 'find_broken_links',
      description:
        'Find all broken/unresolved links in the vault. These are links to notes that don\'t exist yet.',
      parameters: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: 'Optional folder to search in. If not provided, searches entire vault.',
          },
        },
      },
      handler: this.wrapHandler(async (params) => {
        const folder = params.folder as string | undefined;

        const unresolvedLinks = this.app.metadataCache.unresolvedLinks;
        const brokenLinks: Array<{
          sourcePath: string;
          sourceTitle: string;
          brokenLink: string;
          count: number;
        }> = [];

        for (const [sourcePath, targets] of Object.entries(unresolvedLinks)) {
          // Filter by folder if specified
          if (folder && !sourcePath.startsWith(folder)) continue;

          const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
          if (!sourceFile || !('extension' in sourceFile)) continue;

          const cache = this.app.metadataCache.getFileCache(sourceFile as TFile);
          const sourceTitle = (cache?.frontmatter?.title as string) || (sourceFile as TFile).basename;

          for (const [targetLink, count] of Object.entries(targets)) {
            brokenLinks.push({
              sourcePath,
              sourceTitle,
              brokenLink: targetLink,
              count,
            });
          }
        }

        // Group by broken link to see which ones are most referenced
        const linkCounts = new Map<string, number>();
        for (const bl of brokenLinks) {
          linkCounts.set(bl.brokenLink, (linkCounts.get(bl.brokenLink) || 0) + bl.count);
        }

        const topMissing = Array.from(linkCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([link, count]) => ({ link, totalReferences: count }));

        return {
          totalBrokenLinks: brokenLinks.length,
          folder: folder || '(entire vault)',
          topMissingNotes: topMissing,
          brokenLinks: brokenLinks.slice(0, 100), // Limit results
        };
      }),
    };
  }

  /**
   * Suggest links for a note based on semantic similarity
   */
  private getSuggestLinksTool(): ToolDefinition {
    return {
      name: 'suggest_links',
      description:
        'Suggest notes that could be linked to/from the given note based on semantic similarity. Helps discover hidden connections in your knowledge base.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the note to find suggestions for',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of suggestions (default: 10)',
          },
          excludeExisting: {
            type: 'boolean',
            description: 'Exclude notes that are already linked (default: true)',
          },
        },
        required: ['path'],
      },
      handler: this.wrapHandler(async (params) => {
        const filepath = params.path as string;
        const limit = (params.limit as number) || 10;
        const excludeExisting = params.excludeExisting !== false;

        const file = this.getFileOrError(filepath);
        if ('error' in file) return file;

        // Get existing links to exclude
        const existingLinks = new Set<string>();
        if (excludeExisting) {
          const resolved = this.app.metadataCache.resolvedLinks[filepath] || {};
          for (const link of Object.keys(resolved)) {
            existingLinks.add(link);
          }
          // Also check incoming links
          const allLinks = this.app.metadataCache.resolvedLinks;
          for (const [sourcePath, targets] of Object.entries(allLinks)) {
            if (targets[filepath]) {
              existingLinks.add(sourcePath);
            }
          }
        }

        // Use RAG service for semantic search if available
        if (!this.ragService) {
          return { error: 'RAG service not available. Enable embeddings in settings.' };
        }

        const content = await this.app.vault.cachedRead(file);
        const results = await this.ragService.search(content.slice(0, 2000), { limit: limit + existingLinks.size });

        const suggestions: Array<{
          path: string;
          title: string;
          similarity: number;
          reason: string;
        }> = [];

        for (const result of results) {
          const resultPath = result.document.filepath;
          // Skip the source file itself
          if (resultPath === filepath) continue;
          // Skip existing links if requested
          if (excludeExisting && existingLinks.has(resultPath)) continue;

          const resultFile = this.app.vault.getAbstractFileByPath(resultPath);
          if (!resultFile || !('extension' in resultFile)) continue;

          const cache = this.app.metadataCache.getFileCache(resultFile as TFile);
          suggestions.push({
            path: resultPath,
            title: (cache?.frontmatter?.title as string) || (resultFile as TFile).basename,
            similarity: result.score,
            reason: result.document.content.slice(0, 200) + '...',
          });

          if (suggestions.length >= limit) break;
        }

        return {
          sourceNote: filepath,
          excludedExistingLinks: excludeExisting,
          suggestions,
        };
      }),
    };
  }

  /**
   * Rename/move a file or folder
   */
  private getRenameTool(): ToolDefinition {
    return {
      name: 'rename',
      description:
        'Rename or move a file or folder to a new path. Updates all links automatically.',
      parameters: {
        type: 'object',
        properties: {
          oldPath: {
            type: 'string',
            description: 'Current path of the file or folder',
          },
          newPath: {
            type: 'string',
            description: 'New path for the file or folder',
          },
        },
        required: ['oldPath', 'newPath'],
      },
      handler: this.wrapHandler(async (params) => {
        const oldPath = params.oldPath as string;
        const newPath = params.newPath as string;

        const item = this.app.vault.getAbstractFileByPath(oldPath);
        if (!item) {
          return { error: `Path not found: ${oldPath}` };
        }

        if (this.app.vault.getAbstractFileByPath(newPath)) {
          return { error: `Destination already exists: ${newPath}` };
        }

        const isFolder = 'children' in item;
        await this.ensureParentFolder(newPath);
        await this.app.fileManager.renameFile(item, newPath);

        // Verify rename: new path should exist, old path should not
        const atNewPath = this.app.vault.getAbstractFileByPath(newPath);
        const atOldPath = this.app.vault.getAbstractFileByPath(oldPath);

        if (!atNewPath) {
          return { error: `Rename verification failed: file not found at new path ${newPath}` };
        }
        if (atOldPath) {
          return { error: `Rename verification failed: file still exists at old path ${oldPath}` };
        }

        return {
          success: true,
          oldPath,
          newPath,
          type: isFolder ? 'folder' : 'file',
          message: `${isFolder ? 'Folder' : 'File'} renamed and links updated`,
          verified: true,
        };
      }),
    };
  }

  /**
   * Run a Dataview query (requires Dataview plugin)
   */
  private getDataviewQueryTool(): ToolDefinition {
    return {
      name: 'run_dataview_query',
      description:
        'Execute a Dataview Query Language (DQL) query against the vault. Requires the Dataview plugin to be installed and enabled. Use for advanced queries like finding notes by metadata, creating tables, or filtering by properties. Examples: TABLE file.mtime FROM "Projects" WHERE status = "active" SORT file.mtime DESC',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The DQL query to execute. Can be TABLE, LIST, TASK, or CALENDAR query.',
          },
          format: {
            type: 'string',
            enum: ['table', 'list', 'json'],
            description: 'Output format: table (markdown table), list (markdown list), or json (raw data). Default: json',
          },
        },
        required: ['query'],
      },
      handler: this.wrapHandler(async (params) => {
        const query = params.query as string;
        const format = (params.format as string) || 'json';

        // Check if Dataview plugin is available
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dataviewPlugin = (this.app as any).plugins?.plugins?.dataview;
        if (!dataviewPlugin) {
          return {
            error: 'Dataview plugin is not installed or enabled. Install it from Community Plugins to use this tool.',
          };
        }

        const dataviewApi = dataviewPlugin.api;
        if (!dataviewApi) {
          return {
            error: 'Dataview API is not available. Make sure Dataview is properly initialized.',
          };
        }

        try {
          // Execute the query using Dataview's query API
          const result = await dataviewApi.query(query);

          if (!result.successful) {
            return {
              error: `Query failed: ${result.error || 'Unknown error'}`,
              query,
            };
          }

          const data = result.value;

          // Format based on type
          if (format === 'json') {
            if (data.type === 'table') {
              return {
                type: 'table',
                headers: data.headers,
                rows: data.values.map((row: unknown[]) =>
                  row.map((cell) => this.formatDataviewValue(cell))
                ),
                count: data.values.length,
              };
            } else if (data.type === 'list') {
              return {
                type: 'list',
                items: data.values.map((item: unknown) => this.formatDataviewValue(item)),
                count: data.values.length,
              };
            } else if (data.type === 'task') {
              return {
                type: 'task',
                tasks: data.values.map((task: { text: string; completed: boolean; path: string }) => ({
                  text: task.text,
                  completed: task.completed,
                  path: task.path,
                })),
                count: data.values.length,
              };
            }
            return { type: data.type, data };
          } else if (format === 'table') {
            if (data.type === 'table' && data.headers && data.values) {
              const headers = data.headers.join(' | ');
              const separator = data.headers.map(() => '---').join(' | ');
              const rows = data.values
                .map((row: unknown[]) =>
                  row.map((cell) => this.formatDataviewValue(cell)).join(' | ')
                )
                .join('\n');
              return {
                markdown: `| ${headers} |\n| ${separator} |\n| ${rows.split('\n').join(' |\n| ')} |`,
                count: data.values.length,
              };
            }
            return { error: 'Query result is not a table', type: data.type };
          } else if (format === 'list') {
            if (data.type === 'list' && data.values) {
              const items = data.values
                .map((item: unknown) => `- ${this.formatDataviewValue(item)}`)
                .join('\n');
              return {
                markdown: items,
                count: data.values.length,
              };
            } else if (data.type === 'task' && data.values) {
              const tasks = data.values
                .map(
                  (task: { text: string; completed: boolean }) =>
                    `- [${task.completed ? 'x' : ' '}] ${task.text}`
                )
                .join('\n');
              return {
                markdown: tasks,
                count: data.values.length,
              };
            }
            return { error: 'Query result is not a list or task', type: data.type };
          }

          return { data };
        } catch (error) {
          return {
            error: `Dataview query error: ${error instanceof Error ? error.message : String(error)}`,
            query,
          };
        }
      }),
    };
  }

  /**
   * Format a Dataview value for display
   */
  private formatDataviewValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    // Handle Dataview Link objects
    if (typeof value === 'object' && value !== null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj = value as any;
      if (obj.path !== undefined && obj.display !== undefined) {
        // It's a Link
        return `[[${obj.path}${obj.display ? '|' + obj.display : ''}]]`;
      }
      if (obj.ts !== undefined) {
        // It's a DateTime
        return new Date(obj.ts).toISOString();
      }
      if (Array.isArray(value)) {
        return value.map((v) => this.formatDataviewValue(v)).join(', ');
      }
      return JSON.stringify(value);
    }
    return String(value);
  }

  /**
   * Get vault instruction files (CLAUDE.md, AGENTS.md) for agent context.
   * Convention-based search — checks well-known locations in priority order.
   */
  private getInstructionsTool(): ToolDefinition {
    const SEARCH_LOCATIONS = [
      'CLAUDE.md',
      'AGENTS.md',
      '.obsidian/CLAUDE.md',
      '.obsidian/AGENTS.md',
    ];

    return {
      name: 'get_instructions',
      description:
        'Get vault-specific instructions and conventions for working with this vault. ' +
        'Call this FIRST when starting work with a vault to learn folder structure conventions, ' +
        'tagging rules, frontmatter requirements, linking preferences, and other vault-specific context. ' +
        'Searches well-known locations (CLAUDE.md, AGENTS.md) at vault root and in .obsidian/.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Optional: read a specific instruction file by path instead of searching default locations',
          },
        },
      },
      handler: this.wrapHandler(async (params) => {
        const specificPath = params.path as string | undefined;

        if (specificPath) {
          const file = this.app.vault.getAbstractFileByPath(specificPath);
          if (!file || !(file instanceof TFile)) {
            return { found: false, error: `Instruction file not found: ${specificPath}` };
          }
          const content = await this.app.vault.cachedRead(file);
          return {
            found: true,
            files: [{ path: specificPath, content, size: content.length }],
          };
        }

        const files: Array<{ path: string; content: string; size: number }> = [];

        for (const location of SEARCH_LOCATIONS) {
          const file = this.app.vault.getAbstractFileByPath(location);
          if (file && file instanceof TFile) {
            const content = await this.app.vault.cachedRead(file);
            files.push({ path: location, content, size: content.length });
          }
        }

        return {
          found: files.length > 0,
          files,
          searchedLocations: SEARCH_LOCATIONS,
        };
      }),
    };
  }

  /**
   * Execute a tool by name
   */
  async executeTool(
    name: string,
    params: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<string> {
    const tool = this.getToolDefinitions().find((t) => t.name === name);
    if (!tool) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    return tool.handler(params, context);
  }

  /**
   * Get tool schemas in a format suitable for MCP or Claude
   */
  getToolSchemas(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> {
    return this.getToolDefinitions().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  // --- Resource helpers for MCP resource subscriptions ---

  /** List all markdown notes in the vault as resource metadata */
  listVaultNotes(): Array<{ path: string; name: string; size: number; mtime: number }> {
    return this.app.vault.getMarkdownFiles().map((file) => ({
      path: file.path,
      name: file.basename,
      size: file.stat.size,
      mtime: file.stat.mtime,
    }));
  }

  /** Read a vault file's content by path. Returns null if not found. */
  async readVaultFile(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !('extension' in file)) return null;
    return this.app.vault.cachedRead(file as TFile);
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

    return () => {
      this.app.vault.off('create', onCreate);
      this.app.vault.off('modify', onModify);
      this.app.vault.off('delete', onDelete);
      this.app.vault.off('rename', onRename);
    };
  }

  // --- Completion helpers for MCP autocomplete ---

  /** Get vault file paths matching a prefix, for autocomplete */
  getVaultPaths(prefix?: string, limit = 100): string[] {
    const files = this.app.vault.getFiles();
    const paths = files.map((f) => f.path);
    if (!prefix) return paths.slice(0, limit);
    const lower = prefix.toLowerCase();
    return paths.filter((p) => p.toLowerCase().startsWith(lower)).slice(0, limit);
  }

  /** Get all tags in the vault matching a prefix, for autocomplete */
  getVaultTags(prefix?: string, limit = 100): string[] {
    const tagCounts = (this.app.metadataCache as unknown as { getTags(): Record<string, number> }).getTags();
    const tags = Object.keys(tagCounts);
    if (!prefix) return tags.slice(0, limit);
    const lower = prefix.toLowerCase();
    return tags.filter((t) => t.toLowerCase().startsWith(lower)).slice(0, limit);
  }
}
