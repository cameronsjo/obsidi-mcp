import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { createLogger } from './logger';

const log = createLogger('ClaudePath');

const isWindows = platform() === 'win32';

/**
 * Returns an enhanced PATH that includes common Node/Homebrew locations.
 * This is needed because Electron's PATH often doesn't include these directories.
 */
export function getEnhancedPath(): string {
  const currentPath = process.env.PATH || '';
  const home = homedir();
  const pathSep = isWindows ? ';' : ':';

  const additionalPaths = isWindows
    ? [
        join(process.env.APPDATA || '', 'npm'),
        join(home, 'scoop', 'shims'),
        'C:\\Program Files\\nodejs',
      ]
    : [
        '/opt/homebrew/bin', // macOS ARM Homebrew
        '/usr/local/bin', // macOS Intel Homebrew / Linux
        '/usr/bin',
        join(home, '.npm-global', 'bin'),
        join(home, '.local', 'bin'),
        join(home, 'bin'),
        // nvm paths
        join(home, '.nvm', 'versions', 'node', 'default', 'bin'),
        // fnm paths
        join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
      ];

  // Add paths that exist and aren't already in PATH
  const pathsToAdd = additionalPaths.filter(
    (p) => existsSync(p) && !currentPath.includes(p)
  );

  if (pathsToAdd.length > 0) {
    log.debug('Enhancing PATH with additional directories', { count: pathsToAdd.length });
  }

  return [...pathsToAdd, currentPath].join(pathSep);
}
