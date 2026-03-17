import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BrowserManager } from './browser.js';
import { parseCommand, serializeResponse, errorResponse } from './protocol.js';
import { executeCommand, initActionPolicy } from './actions.js';
import { StreamServer } from './stream-server.js';
import {
  getApiKey,
  setConfigValue,
  removeConfigValue,
  listConfig,
  getConfigValue,
} from './config.js';
import {
  getSessionsDir,
  ensureSessionsDir,
  getEncryptionKey,
  encryptData,
  isValidSessionName,
  cleanupExpiredStates,
  getAutoStateFilePath,
} from './state-utils.js';
import { configureLogger, LogLevel } from './logger.js';

/**
 * Backpressure-aware socket write.
 * If the kernel buffer is full (socket.write returns false),
 * waits for the 'drain' event before resolving.
 */
export function safeWrite(socket: net.Socket, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    const canContinue = socket.write(payload);
    if (canContinue) {
      resolve();
    } else if (socket.destroyed) {
      resolve();
    } else {
      const cleanup = () => {
        socket.removeListener('drain', onDrain);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      socket.once('drain', onDrain);
      socket.once('error', onError);
      socket.once('close', onClose);
    }
  });
}

// Platform detection
const isWindows = process.platform === 'win32';

// Session support - each session gets its own socket/pid
let currentSession = 'default';

// Stream server for browser preview
let streamServer: StreamServer | null = null;

// Default stream port
const DEFAULT_STREAM_PORT = 9223;

/**
 * Save state to file with optional encryption.
 */
async function saveStateToFile(
  browser: BrowserManager,
  filepath: string
): Promise<{ encrypted: boolean }> {
  const context = browser.getContext();
  if (!context) {
    throw new Error('No browser context available');
  }

  const state = await context.storageState();
  const jsonData = JSON.stringify(state, null, 2);

  const key = getEncryptionKey();
  if (key) {
    const encrypted = encryptData(jsonData, key);
    fs.writeFileSync(filepath, JSON.stringify(encrypted, null, 2));
    return { encrypted: true };
  }

  fs.writeFileSync(filepath, jsonData);
  return { encrypted: false };
}

const AUTO_EXPIRE_ENV = 'SCRAPELESS_BROWSER_STATE_EXPIRE_DAYS';
const DEFAULT_EXPIRE_DAYS = 30;

function runCleanupExpiredStates(): void {
  const expireDaysStr = process.env[AUTO_EXPIRE_ENV];
  const expireDays = expireDaysStr ? parseInt(expireDaysStr, 10) : DEFAULT_EXPIRE_DAYS;

  if (isNaN(expireDays) || expireDays <= 0) {
    return;
  }

  try {
    const deleted = cleanupExpiredStates(expireDays);
    // Cleanup completed silently
  } catch (err) {
    // Cleanup failed silently
  }
}

/**
 * Get the validated session name and auto-state file path.
 * Centralizes session name validation to prevent path traversal.
 */
function getSessionAutoStatePath(): string | undefined {
  // Session state management removed - use config file instead
  return undefined;
}

/**
 * Get the auto-state file path for saving (creates sessions dir if needed).
 * Returns undefined if no valid session name is configured.
 */
function getSessionSaveStatePath(): string | undefined {
  // Session state management removed - use config file instead
  return undefined;
}

/**
 * Set the current session
 */
export function setSession(session: string): void {
  currentSession = session;
}

/**
 * Get the current session
 */
export function getSession(): string {
  return currentSession;
}

/**
 * Get port number for TCP mode (Windows)
 * Uses a hash of the session name to get a consistent port
 */
function getPortForSession(session: string): number {
  let hash = 0;
  for (let i = 0; i < session.length; i++) {
    hash = (hash << 5) - hash + session.charCodeAt(i);
    hash |= 0;
  }
  // Port range 49152-65535 (dynamic/private ports)
  return 49152 + (Math.abs(hash) % 16383);
}

/**
 * Get the base directory for socket/pid files.
 * Priority: SCRAPELESS_BROWSER_SOCKET_DIR > XDG_RUNTIME_DIR > ~/.scrapeless-scraping-browser > tmpdir
 */
export function getAppDir(): string {
  // 1. XDG_RUNTIME_DIR (Linux standard)
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, 'agent-browser');
  }

  // 2. Home directory fallback (like Docker Desktop's ~/.docker/run/)
  const homeDir = os.homedir();
  if (homeDir) {
    return path.join(homeDir, '.scrapeless-scraping-browser');
  }

  // 3. Last resort: temp dir
  return path.join(os.tmpdir(), 'agent-browser');
}

export function getSocketDir(): string {
  return getAppDir();
}

/**
 * Get the socket path for the current session (Unix) or port (Windows)
 */
export function getSocketPath(session?: string): string {
  const sess = session ?? currentSession;
  if (isWindows) {
    return String(getPortForSession(sess));
  }
  return path.join(getSocketDir(), `${sess}.sock`);
}

/**
 * Get the port file path for Windows (stores the port number)
 */
export function getPortFile(session?: string): string {
  const sess = session ?? currentSession;
  return path.join(getSocketDir(), `${sess}.port`);
}

/**
 * Get the PID file path for the current session
 */
export function getPidFile(session?: string): string {
  const sess = session ?? currentSession;
  return path.join(getSocketDir(), `${sess}.pid`);
}

/**
 * Check if daemon is running for the current session
 */
export function isDaemonRunning(session?: string): boolean {
  const pidFile = getPidFile(session);
  if (!fs.existsSync(pidFile)) return false;

  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    // Check if process exists (works on both Unix and Windows)
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but we lack permission to signal it
    // (e.g. caller is inside a macOS sandbox). Only ESRCH means it's gone.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }
    // Process doesn't exist, clean up stale files
    cleanupSocket(session);
    return false;
  }
}

/**
 * Get connection info for the current session
 * Returns { type: 'unix', path: string } or { type: 'tcp', port: number }
 */
export function getConnectionInfo(
  session?: string
): { type: 'unix'; path: string } | { type: 'tcp'; port: number } {
  const sess = session ?? currentSession;
  if (isWindows) {
    return { type: 'tcp', port: getPortForSession(sess) };
  }
  return { type: 'unix', path: path.join(getSocketDir(), `${sess}.sock`) };
}

/**
 * Clean up socket and PID file for the current session
 */
export function cleanupSocket(session?: string): void {
  const pidFile = getPidFile(session);
  const streamPortFile = getStreamPortFile(session);
  try {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    if (fs.existsSync(streamPortFile)) fs.unlinkSync(streamPortFile);
    if (isWindows) {
      const portFile = getPortFile(session);
      if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
    } else {
      const socketPath = getSocketPath(session);
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Get the stream port file path
 */
export function getStreamPortFile(session?: string): string {
  const sess = session ?? currentSession;
  return path.join(getSocketDir(), `${sess}.stream`);
}

/**
 * Start the daemon server
 * @param options.streamPort Port for WebSocket stream server (0 to disable)
 */
export async function startDaemon(options?: { streamPort?: number }): Promise<void> {
  // Configure logging based on debug settings
  const debugEnabled = getConfigValue('debug') === 'true';

  configureLogger({
    debug: debugEnabled,
    level: debugEnabled ? LogLevel.DEBUG : LogLevel.INFO,
  });

  // Ensure socket directory exists with restricted permissions (owner-only access)
  const socketDir = getSocketDir();
  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  }

  // Clean up any stale socket
  cleanupSocket();

  // Clean up expired state files on startup
  runCleanupExpiredStates();

  // Initialize action policy enforcement
  initActionPolicy();

  // Create browser manager
  const manager = new BrowserManager();
  let shuttingDown = false;

  // Start stream server if port is specified
  const streamPort = options?.streamPort ?? 0;

  if (streamPort > 0) {
    streamServer = new StreamServer(manager, streamPort);
    await streamServer.start();

    // Write stream port to file for clients to discover
    const streamPortFile = getStreamPortFile();
    fs.writeFileSync(streamPortFile, streamPort.toString());
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    let httpChecked = false;

    // Command serialization: queue incoming lines and process them one at a time.
    // This prevents concurrent command execution which can cause socket.write
    // buffer contention and EAGAIN errors on the Rust CLI side.
    const commandQueue: string[] = [];
    let processing = false;

    async function processQueue(): Promise<void> {
      if (processing) return;
      processing = true;

      while (commandQueue.length > 0) {
        const line = commandQueue.shift()!;

        try {
          const parseResult = parseCommand(line);

          if (!parseResult.success) {
            const resp = errorResponse(parseResult.id ?? 'unknown', parseResult.error);
            await safeWrite(socket, serializeResponse(resp) + '\n');
            continue;
          }

          // Auto-launch if not already launched and this isn't a launch/close/state_load command
          if (
            !manager.isLaunched() &&
            parseResult.command.action !== 'launch' &&
            parseResult.command.action !== 'close' &&
            parseResult.command.action !== 'state_load'
          ) {
            // Auto-launch desktop browser with default settings
            await manager.launch({
              id: 'auto',
              action: 'launch' as const,
              headless: true, // Default to headless
              autoStateFilePath: getSessionAutoStatePath(),
            });
          }

          // Recover from stale state: browser is launched but all pages were closed
          if (
            manager.isLaunched() &&
            !manager.hasPages() &&
            parseResult.command.action !== 'launch' &&
            parseResult.command.action !== 'close'
          ) {
            try {
              await manager.ensurePage();
            } catch (error) {
              // If ensurePage fails for Scrapeless sessions, it might be due to session expiry
              const errorMessage = error instanceof Error ? error.message : String(error);
              if (
                errorMessage.includes('Scrapeless') ||
                errorMessage.includes('closed') ||
                errorMessage.includes('SESSION_TERMINATED') ||
                errorMessage.includes('terminated')
              ) {
                const resp = errorResponse(
                  parseResult.command.id ?? 'unknown',
                  `Scrapeless session has been terminated and cannot be reconnected. ` +
                    `Scrapeless sessions automatically terminate when the connection is closed. ` +
                    `Please create a new session to continue. ` +
                    `Use 'create --name <name> --ttl <seconds>' to create a new session.`
                );
                await safeWrite(socket, serializeResponse(resp) + '\n');
                continue;
              } else {
                throw error;
              }
            }
          }

          // Handle explicit launch with auto-load state
          if (parseResult.command.action === 'launch' && !parseResult.command.autoStateFilePath) {
            const autoStatePath = getSessionAutoStatePath();
            if (autoStatePath) {
              parseResult.command.autoStateFilePath = autoStatePath;
            }
          }

          // Handle close command specially - shuts down daemon
          if (parseResult.command.action === 'close') {
            // Auto-save state before closing
            if (manager.isLaunched()) {
              const savePath = getSessionSaveStatePath();
              if (savePath) {
                try {
                  const { encrypted } = await saveStateToFile(manager, savePath);
                  fs.chmodSync(savePath, 0o600);
                  // State saved silently
                } catch (err) {
                  // Save failed silently
                }
              }
            }

            const response = await executeCommand(parseResult.command, manager);
            await safeWrite(socket, serializeResponse(response) + '\n');

            if (!shuttingDown) {
              shuttingDown = true;
              setTimeout(() => {
                server.close();
                cleanupSocket();
                process.exit(0);
              }, 100);
            }

            commandQueue.length = 0;
            processing = false;
            return;
          }

          // Execute command
          const response = await executeCommand(parseResult.command, manager);

          // Add any launch warnings to the response
          const warnings = manager.getAndClearWarnings();
          if (warnings.length > 0 && response.success && response.data) {
            (response.data as Record<string, unknown>).warnings = warnings;
          }

          await safeWrite(socket, serializeResponse(response) + '\n');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await safeWrite(socket, serializeResponse(errorResponse('error', message)) + '\n').catch(
            () => {}
          ); // Socket may already be destroyed
        }
      }

      processing = false;
    }

    socket.on('data', (data) => {
      buffer += data.toString();

      // Security: Detect and reject HTTP requests to prevent cross-origin attacks.
      // Browsers using fetch() must send HTTP headers (e.g., "POST / HTTP/1.1"),
      // while legitimate clients send raw JSON starting with "{".
      if (!httpChecked) {
        httpChecked = true;
        const trimmed = buffer.trimStart();
        if (/^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE)\s/i.test(trimmed)) {
          socket.destroy();
          return;
        }
      }

      // Extract complete lines and enqueue them for serial processing
      while (buffer.includes('\n')) {
        const newlineIdx = buffer.indexOf('\n');
        const line = buffer.substring(0, newlineIdx);
        buffer = buffer.substring(newlineIdx + 1);

        if (!line.trim()) continue;
        commandQueue.push(line);
      }

      processQueue().catch((err) => {
        // Socket write failures during queue processing are non-fatal;
        // the client has likely disconnected.
        // Only log err.message to avoid leaking sensitive fields (e.g. passwords) from command objects.
        console.warn('[warn] processQueue error:', err?.message ?? String(err));
      });
    });

    socket.on('error', () => {
      // Client disconnected, ignore
    });
  });

  const pidFile = getPidFile();

  // Write PID file before listening
  fs.writeFileSync(pidFile, process.pid.toString());

  if (isWindows) {
    // Windows: use TCP socket on localhost
    const port = getPortForSession(currentSession);
    const portFile = getPortFile();
    fs.writeFileSync(portFile, port.toString());
    server.listen(port, '127.0.0.1', () => {
      // Daemon is ready on TCP port
    });
  } else {
    // Unix: use Unix domain socket
    const socketPath = getSocketPath();
    server.listen(socketPath, () => {
      // Daemon is ready
    });
  }

  server.on('error', (err) => {
    console.error('Server error:', err);
    cleanupSocket();
    process.exit(1);
  });

  // Handle shutdown signals
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Stop stream server if running
    if (streamServer) {
      await streamServer.stop();
      streamServer = null;
      // Clean up stream port file
      const streamPortFile = getStreamPortFile();
      try {
        if (fs.existsSync(streamPortFile)) fs.unlinkSync(streamPortFile);
      } catch {
        // Ignore cleanup errors
      }
    }

    await manager.close();
    server.close();
    cleanupSocket();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);

  // Handle unexpected errors - always cleanup
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    cleanupSocket();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    cleanupSocket();
    process.exit(1);
  });

  // Cleanup on normal exit
  process.on('exit', () => {
    cleanupSocket();
  });

  // Keep process alive
  process.stdin.resume();
}

/**
 * Execute a single command directly without starting the daemon server
 */
async function executeDirectCommand(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error('No command provided');
    process.exit(1);
  }

  const manager = new BrowserManager();

  try {
    // Initialize action policy
    initActionPolicy();

    // Handle config commands
    if (args[0] === 'config') {
      await handleConfigCommand(args.slice(1));
      return;
    }

    // Create a simple command object for direct execution
    // For now, just handle version command
    if (args[0] === '--version' || args[0] === '-V') {
      console.log('scrapeless-scraping-browser 0.1.0');
      return;
    }

    if (args[0] === '--help' || args[0] === '-h') {
      console.log('scrapeless-scraping-browser - cloud browser automation CLI for AI agents');
      console.log('');
      console.log('Usage: scrapeless-scraping-browser <command> [args] [options]');
      console.log('');
      console.log('Set SCRAPELESS_API_KEY environment variable or use config command.');
      console.log('');
      console.log('Examples:');
      console.log('  scrapeless-scraping-browser config set key your_api_key');
      console.log('  scrapeless-scraping-browser open example.com');
      console.log('  scrapeless-scraping-browser snapshot -i');
      console.log('  scrapeless-scraping-browser click @e1');
      return;
    }

    // For other commands, we need to create a proper command object
    const commandStr = JSON.stringify({
      action: args[0],
      args: args.slice(1),
      id: 'direct-' + Date.now(),
    });

    const parseResult = parseCommand(commandStr);
    if (!parseResult.success) {
      console.error('Invalid command:', parseResult.error);
      process.exit(1);
    }

    const result = await executeCommand(parseResult.command, manager);

    // Output the result
    if (result.success) {
      if (result.data) {
        console.log(JSON.stringify(result.data, null, 2));
      }
    } else {
      console.error('Error:', result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error('Command execution failed:', error);
    process.exit(1);
  } finally {
    // Clean up
    await manager.close();
  }
}

/**
 * Handle config commands
 */
async function handleConfigCommand(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error('Config command requires subcommand: set, get, list, remove');
    process.exit(1);
  }

  const subcommand = args[0];

  switch (subcommand) {
    case 'set':
      if (args.length < 3) {
        console.error('Usage: config set <key> <value>');
        process.exit(1);
      }
      const key = args[1];
      const value = args[2];

      // Validate key
      const validKeys = [
        'key',
        'apiVersion',
        'sessionTtl',
        'sessionName',
        'sessionRecording',
        'proxyUrl',
        'proxyCountry',
        'proxyState',
        'proxyCity',
        'fingerprint',
        'debug',
      ];
      if (!validKeys.includes(key)) {
        console.error(`Invalid key: ${key}. Valid keys: ${validKeys.join(', ')}`);
        process.exit(1);
      }

      // Map 'key' to 'apiKey'
      const configKey = key === 'key' ? 'apiKey' : key;
      setConfigValue(configKey as any, value);
      console.log(`✓ Set ${key} = ${value}`);
      break;

    case 'get':
      if (args.length < 2) {
        console.error('Usage: config get <key>');
        process.exit(1);
      }
      const getKey = args[1] === 'key' ? 'apiKey' : args[1];
      const config = listConfig();
      const configValue = (config as any)[getKey];
      if (configValue !== undefined) {
        console.log(configValue);
      } else {
        console.log('(not set)');
      }
      break;

    case 'list':
      const allConfig = listConfig();
      console.log('Configuration:');
      for (const [k, v] of Object.entries(allConfig)) {
        const displayKey = k === 'apiKey' ? 'key' : k;
        console.log(`  ${displayKey} = ${v}`);
      }
      break;

    case 'remove':
      if (args.length < 2) {
        console.error('Usage: config remove <key>');
        process.exit(1);
      }
      const removeKey = args[1] === 'key' ? 'apiKey' : args[1];
      removeConfigValue(removeKey as any);
      console.log(`✓ Removed ${args[1]}`);
      break;

    default:
      console.error(`Unknown config subcommand: ${subcommand}`);
      console.error('Available subcommands: set, get, list, remove');
      process.exit(1);
  }
}

// Run daemon if this is the entry point
if (process.argv[1]?.endsWith('daemon.js') || process.argv[1]?.endsWith('daemon.ts')) {
  const args = process.argv.slice(2);

  // If we have command line arguments, execute them directly
  if (args.length > 0) {
    executeDirectCommand(args).catch((err) => {
      console.error('Command error:', err);
      process.exit(1);
    });
  } else {
    // Otherwise start the daemon server
    startDaemon().catch((err) => {
      console.error('Daemon error:', err);
      cleanupSocket();
      process.exit(1);
    });
  }
}
