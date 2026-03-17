/**
 * Legacy API client - DEPRECATED
 * Use the new API structure in ./api/ instead
 *
 * This file is kept for backward compatibility
 */

import { ScrapelessAPI } from './api/index.js';
import { getApiKey } from './config.js';
import { logger } from './logger.js';

// Legacy interface for backward compatibility
export interface SessionCreateParams {
  sessionTtl?: string;
  sessionName?: string;
  sessionRecording?: string;
  proxyUrl?: string;
  proxyCountry?: string;
  proxyState?: string;
  proxyCity?: string;
  fingerprint?: string;
  metadata?: Record<string, string>;
  userAgent?: string;
  platform?: string;
  screenWidth?: number;
  screenHeight?: number;
  timezone?: string;
  languages?: string[];
}

export interface SessionInfo {
  sessionId: string;
  createdAt: string;
  status: string;
  name?: string;
  metadata?: Record<string, any>;
}

export interface SessionCreateResponse {
  success: boolean;
  taskId: string;
  sessionId?: string;
}

export interface SessionListResponse {
  sessions: SessionInfo[];
}

/**
 * Legacy API client wrapper
 * @deprecated Use ScrapelessAPI instead
 */
export class ScrapelessApiClient {
  private api: ScrapelessAPI;

  constructor(apiKey?: string, apiVersion?: string) {
    console.log(
      'ScrapelessApiClient constructor called with apiKey:',
      apiKey ? `${apiKey.slice(0, 5)}...${apiKey.slice(-5)}` : 'undefined'
    );
    this.api = new ScrapelessAPI({ apiKey });

    if (apiVersion && apiVersion !== 'v2') {
      logger.warn('API version parameter is deprecated. Only v2 is supported.');
    }
  }

  async createSession(params: SessionCreateParams = {}): Promise<SessionCreateResponse> {
    const options = {
      sessionTTL: params.sessionTtl ? parseInt(params.sessionTtl) : undefined,
      sessionName: params.sessionName,
      sessionRecording: params.sessionRecording === 'true',
      proxyURL: params.proxyUrl,
      proxyCountry: params.proxyCountry,
      proxyState: params.proxyState,
      proxyCity: params.proxyCity,
      fingerprint: params.fingerprint,
      userAgent: params.userAgent,
      platform: params.platform,
      screen:
        params.screenWidth && params.screenHeight
          ? {
              width: params.screenWidth,
              height: params.screenHeight,
            }
          : undefined,
      localization:
        params.timezone || params.languages
          ? {
              basedOnIP: false,
              timezone: params.timezone || 'America/New_York',
              languages: params.languages || ['en'],
            }
          : undefined,
    };

    const result = await this.api.browser.createSession(options);
    return {
      success: result.success,
      taskId: result.taskId,
      sessionId: result.taskId,
    };
  }

  async listSessions(): Promise<SessionListResponse> {
    const sessions = await this.api.browser.getRunningSessions();

    return {
      sessions: sessions.map((session) => ({
        sessionId: session.taskId,
        createdAt: session.createTime,
        status: session.state,
        name: session.metadata?.session_name,
        metadata: session.metadata,
      })),
    };
  }

  async stopSession(sessionId: string): Promise<{ success: boolean; message?: string }> {
    logger.warn('Session stopping is not supported by the API. Sessions auto-expire based on TTL.');
    return {
      success: false,
      message: 'Session stopping not supported by API. Sessions will auto-expire based on TTL.',
    };
  }

  async stopAllSessions(): Promise<{ success: boolean; stopped: number; message?: string }> {
    logger.warn('Session stopping is not supported by the API. Sessions auto-expire based on TTL.');
    return {
      success: false,
      stopped: 0,
      message: 'Session stopping not supported by API. Sessions will auto-expire based on TTL.',
    };
  }

  async getLiveUrl(sessionId: string): Promise<{ url: string }> {
    const url = await this.api.browser.getLiveUrl(sessionId);
    return { url };
  }

  getCdpUrl(sessionId: string): string {
    return this.api.browser.createWebSocketConnection(sessionId);
  }

  async getLatestSession(): Promise<SessionInfo | null> {
    const session = await this.api.browser.getLatestSession();

    if (!session) return null;

    return {
      sessionId: session.taskId,
      createdAt: session.createTime,
      status: session.state,
      name: session.metadata?.session_name,
      metadata: session.metadata,
    };
  }

  getApiVersion(): string {
    return 'v2';
  }

  supportsFeature(feature: 'proxy_state' | 'proxy_city' | 'metadata'): boolean {
    return true; // All features supported in v2
  }
}

// Global API client instance
let globalApiClient: ScrapelessApiClient | null = null;

/**
 * Get the global API client instance
 * @deprecated Use new ScrapelessAPI instead
 */
export function getApiClient(): ScrapelessApiClient {
  if (!globalApiClient) {
    const apiKey = getApiKey();
    console.log(
      'API key from config:',
      apiKey ? `${apiKey.slice(0, 5)}...${apiKey.slice(-5)}` : 'undefined'
    );
    globalApiClient = new ScrapelessApiClient(apiKey);
  }
  return globalApiClient;
}

/**
 * Reset the global API client (for testing or config changes)
 * @deprecated Use new ScrapelessAPI instead
 */
export function resetApiClient(): void {
  globalApiClient = null;
}
