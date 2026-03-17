import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ScrapelessConfig {
  apiKey?: string;
  apiVersion?: string;
  sessionTtl?: number;
  sessionName?: string;
  sessionRecording?: boolean;
  proxyUrl?: string;
  proxyCountry?: string;
  proxyState?: string;
  proxyCity?: string;
  fingerprint?: string;
  debug?: boolean;
  // Body parameters
  userAgent?: string;
  platform?: string;
  screenWidth?: number;
  screenHeight?: number;
  timezone?: string;
  languages?: string; // Comma-separated list
}

/**
 * Get the config file path
 */
export function getConfigPath(): string {
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.scrapeless');

  // Ensure config directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  return path.join(configDir, 'config.json');
}

/**
 * Load configuration from file
 */
export function loadConfig(): ScrapelessConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.warn('Warning: Failed to parse config file, using defaults');
    return {};
  }
}

/**
 * Save configuration to file
 */
export function saveConfig(config: ScrapelessConfig): void {
  const configPath = getConfigPath();

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  } catch (error) {
    throw new Error(`Failed to save config: ${error}`);
  }
}

/**
 * Get configuration value with priority: config file > default
 * Only SCRAPELESS_API_KEY environment variable is supported for security reasons
 */
export function getConfigValue(
  key: keyof ScrapelessConfig,
  defaultValue?: string
): string | undefined {
  const config = loadConfig();

  // Priority 1: Config file
  const configValue = config[key];
  if (configValue !== undefined) {
    return String(configValue);
  }

  // Priority 2: Environment variable (ONLY for API key for security)
  if (key === 'apiKey') {
    const envValue = process.env.SCRAPELESS_API_KEY;
    if (envValue !== undefined) {
      return envValue;
    }
  }

  // Priority 3: Default value
  return defaultValue;
}

/**
 * Get API key with proper priority
 */
export function getApiKey(): string | undefined {
  return getConfigValue('apiKey');
}

/**
 * Set configuration value
 */
export function setConfigValue(key: keyof ScrapelessConfig, value: string): void {
  const config = loadConfig();

  // Convert string values to appropriate types
  let typedValue: any = value;
  if (key === 'sessionTtl' || key === 'screenWidth' || key === 'screenHeight') {
    typedValue = parseInt(value, 10);
  } else if (key === 'sessionRecording' || key === 'debug') {
    typedValue = value.toLowerCase() === 'true';
  }

  config[key] = typedValue;
  saveConfig(config);
}

/**
 * Remove configuration value
 */
export function removeConfigValue(key: keyof ScrapelessConfig): void {
  const config = loadConfig();
  delete config[key];
  saveConfig(config);
}

/**
 * List all configuration values
 */
export function listConfig(): ScrapelessConfig {
  return loadConfig();
}
