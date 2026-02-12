/**
 * Structured logging utility for Obsidi MCP plugin
 *
 * Provides consistent log formatting across all components with:
 * - Timestamps in ISO format
 * - Component identification
 * - Structured context data
 * - Appropriate severity levels
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: unknown;
}

/** Callback signature for external log sinks (e.g., MCP logging transport) */
export type LogSink = (entry: LogEntry) => void;

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  action: string;
  context?: LogContext;
  error?: Error;
}

/**
 * Format a log entry for console output
 */
function formatLogEntry(entry: LogEntry): string {
  const parts = [
    `[${entry.timestamp}]`,
    `[${entry.component}]`,
    entry.action,
  ];

  if (entry.context && Object.keys(entry.context).length > 0) {
    const contextStr = Object.entries(entry.context)
      .map(([k, v]) => `${k}=${formatValue(v)}`)
      .join(', ');
    parts.push(`{${contextStr}}`);
  }

  return parts.join(' ');
}

/**
 * Format a value for log output
 */
function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return `{${keys.length} keys}`;
  }
  return String(value);
}

/**
 * Logger class for a specific component
 */
export class Logger {
  private component: string;
  private static globalEnabled = true;
  private static minLevel: LogLevel = 'debug';
  private static sinks: Set<LogSink> = new Set();

  constructor(component: string) {
    this.component = component;
  }

  static setEnabled(enabled: boolean): void {
    Logger.globalEnabled = enabled;
  }

  static setMinLevel(level: LogLevel): void {
    Logger.minLevel = level;
  }

  /** Register an external log sink. Returns an unsubscribe function. */
  static addSink(sink: LogSink): () => void {
    Logger.sinks.add(sink);
    return () => Logger.sinks.delete(sink);
  }

  private shouldLog(level: LogLevel): boolean {
    if (!Logger.globalEnabled) return false;

    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const minIndex = levels.indexOf(Logger.minLevel);
    const currentIndex = levels.indexOf(level);

    return currentIndex >= minIndex;
  }

  private createEntry(
    level: LogLevel,
    action: string,
    context?: LogContext,
    error?: Error
  ): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      action,
      context,
      error,
    };
  }

  private dispatchToSinks(entry: LogEntry): void {
    for (const sink of Logger.sinks) {
      try {
        sink(entry);
      } catch {
        // Sink errors must not break logging
      }
    }
  }

  debug(action: string, context?: LogContext): void {
    if (!this.shouldLog('debug')) return;
    const entry = this.createEntry('debug', action, context);
    console.debug(formatLogEntry(entry));
    this.dispatchToSinks(entry);
  }

  info(action: string, context?: LogContext): void {
    if (!this.shouldLog('info')) return;
    const entry = this.createEntry('info', action, context);
    console.info(formatLogEntry(entry));
    this.dispatchToSinks(entry);
  }

  warn(action: string, context?: LogContext): void {
    if (!this.shouldLog('warn')) return;
    const entry = this.createEntry('warn', action, context);
    console.warn(formatLogEntry(entry));
    this.dispatchToSinks(entry);
  }

  error(action: string, error?: Error | unknown, context?: LogContext): void {
    if (!this.shouldLog('error')) return;
    const err = error instanceof Error ? error : undefined;
    const entry = this.createEntry('error', action, context, err);
    const message = formatLogEntry(entry);
    if (err) {
      console.error(message, err);
    } else if (error !== undefined) {
      console.error(message, error);
    } else {
      console.error(message);
    }
    this.dispatchToSinks(entry);
  }

  child(subComponent: string): Logger {
    return new Logger(`${this.component}:${subComponent}`);
  }

  async time<T>(
    action: string,
    operation: () => Promise<T>,
    context?: LogContext
  ): Promise<T> {
    const start = performance.now();
    this.debug(`${action} started`, context);
    try {
      const result = await operation();
      const duration = Math.round(performance.now() - start);
      this.info(`${action} completed`, { ...context, durationMs: duration });
      return result;
    } catch (error) {
      const duration = Math.round(performance.now() - start);
      this.error(`${action} failed`, error, { ...context, durationMs: duration });
      throw error;
    }
  }
}

export function createLogger(component: string): Logger {
  return new Logger(component);
}
