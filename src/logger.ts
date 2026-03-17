/**
 * Logger utility for Scrapeless Browser Skills
 */

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4,
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: Date;
  context?: Record<string, any>;
  error?: Error;
}

export class Logger {
  private static instance: Logger;
  private level: LogLevel = LogLevel.INFO;
  private enableConsole: boolean = true;
  private entries: LogEntry[] = [];
  private maxEntries: number = 1000;

  private constructor() {}

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setConsoleEnabled(enabled: boolean): void {
    this.enableConsole = enabled;
  }

  setMaxEntries(max: number): void {
    this.maxEntries = max;
    this.trimEntries();
  }

  private shouldLog(level: LogLevel): boolean {
    return level <= this.level;
  }

  private addEntry(entry: LogEntry): void {
    this.entries.push(entry);
    this.trimEntries();
  }

  private trimEntries(): void {
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  private formatMessage(level: LogLevel, message: string, context?: Record<string, any>): string {
    const timestamp = new Date().toISOString();
    const levelName = LogLevel[level];
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    return `[${timestamp}] ${levelName}: ${message}${contextStr}`;
  }

  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, any>,
    error?: Error
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      context,
      error,
    };

    this.addEntry(entry);

    if (this.enableConsole) {
      const formatted = this.formatMessage(level, message, context);

      switch (level) {
        case LogLevel.ERROR:
          console.error(formatted, error || '');
          break;
        case LogLevel.WARN:
          console.warn(formatted);
          break;
        case LogLevel.INFO:
          console.info(formatted);
          break;
        case LogLevel.DEBUG:
        case LogLevel.TRACE:
          console.debug(formatted);
          break;
      }
    }
  }

  error(message: string, error?: Error, context?: Record<string, any>): void {
    this.log(LogLevel.ERROR, message, context, error);
  }

  warn(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.WARN, message, context);
  }

  info(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, context);
  }

  debug(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  trace(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.TRACE, message, context);
  }

  /**
   * Log API request
   */
  logApiRequest(method: string, url: string, headers?: Record<string, string>, body?: any): void {
    this.debug('API Request', {
      method,
      url,
      headers: this.sanitizeHeaders(headers),
      body: this.sanitizeBody(body),
    });
  }

  /**
   * Log API response
   */
  logApiResponse(
    status: number,
    statusText: string,
    headers?: Record<string, string>,
    body?: any
  ): void {
    this.debug('API Response', {
      status,
      statusText,
      headers,
      body: this.sanitizeBody(body),
    });
  }

  /**
   * Log CDP message
   */
  logCDPMessage(direction: 'send' | 'receive', message: any): void {
    this.trace(`CDP ${direction}`, {
      id: message.id,
      method: message.method,
      params: message.params,
      result: message.result,
      error: message.error,
    });
  }

  /**
   * Log session lifecycle events
   */
  logSessionEvent(event: string, sessionId?: string, details?: Record<string, any>): void {
    this.info(`Session ${event}`, {
      sessionId,
      ...details,
    });
  }

  /**
   * Get recent log entries
   */
  getEntries(level?: LogLevel, limit?: number): LogEntry[] {
    let entries = this.entries;

    if (level !== undefined) {
      entries = entries.filter((entry) => entry.level <= level);
    }

    if (limit) {
      entries = entries.slice(-limit);
    }

    return entries;
  }

  /**
   * Clear all log entries
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Export logs as JSON
   */
  exportLogs(): string {
    return JSON.stringify(this.entries, null, 2);
  }

  private sanitizeHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
    if (!headers) return headers;

    const sanitized = { ...headers };

    // Mask sensitive headers
    const sensitiveHeaders = ['authorization', 'x-api-key', 'x-api-token', 'cookie', 'set-cookie'];
    for (const key of Object.keys(sanitized)) {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      }
    }

    return sanitized;
  }

  private sanitizeBody(body?: any): any {
    if (!body) return body;

    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body);
        return this.sanitizeObject(parsed);
      } catch {
        return body;
      }
    }

    return this.sanitizeObject(body);
  }

  private sanitizeObject(obj: any): any {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.sanitizeObject(item));
    }

    const sanitized: any = {};
    const sensitiveKeys = ['password', 'token', 'key', 'secret', 'auth', 'credential'];

    for (const [key, value] of Object.entries(obj)) {
      if (sensitiveKeys.some((sensitive) => key.toLowerCase().includes(sensitive))) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = this.sanitizeObject(value);
      }
    }

    return sanitized;
  }
}

// Global logger instance
export const logger = Logger.getInstance();

// Configure logger based on environment
export function configureLogger(options: {
  debug?: boolean;
  level?: LogLevel;
  console?: boolean;
}): void {
  const { debug, level, console: enableConsole } = options;

  if (debug) {
    logger.setLevel(LogLevel.DEBUG);
  } else if (level !== undefined) {
    logger.setLevel(level);
  }

  if (enableConsole !== undefined) {
    logger.setConsoleEnabled(enableConsole);
  }
}

// Convenience functions
export const log = {
  error: (message: string, error?: Error, context?: Record<string, any>) =>
    logger.error(message, error, context),
  warn: (message: string, context?: Record<string, any>) => logger.warn(message, context),
  info: (message: string, context?: Record<string, any>) => logger.info(message, context),
  debug: (message: string, context?: Record<string, any>) => logger.debug(message, context),
  trace: (message: string, context?: Record<string, any>) => logger.trace(message, context),
};
