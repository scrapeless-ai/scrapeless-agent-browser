/**
 * Scrapeless Browser API
 * Handles browser session management and live preview
 */

import { ScrapelessClient } from './client.js';
import {
  BrowserSession,
  BrowserSessionOptions,
  CreateSessionResponse,
  LiveUrlResponse,
  DEFAULT_BROWSER_OPTIONS,
} from './types.js';

export class ScrapelessBrowserAPI {
  constructor(private client: ScrapelessClient) {}

  /**
   * Create a new browser session
   * Based on: GET /api/v2/browser
   */
  async createSession(options: BrowserSessionOptions = {}): Promise<CreateSessionResponse> {
    const queryParams: Record<string, any> = {};

    // Add query parameters
    if (options.sessionTTL !== undefined) queryParams.sessionTTL = options.sessionTTL;
    if (options.sessionName) queryParams.sessionName = options.sessionName;
    if (options.sessionRecording !== undefined)
      queryParams.sessionRecording = options.sessionRecording;
    if (options.proxyURL) queryParams.proxyURL = options.proxyURL;
    if (options.proxyCountry) queryParams.proxyCountry = options.proxyCountry;
    if (options.proxyState) queryParams.proxyState = options.proxyState;
    if (options.proxyCity) queryParams.proxyCity = options.proxyCity;
    if (options.extensionIds) queryParams.extensionIds = options.extensionIds;
    if (options.fingerprint) queryParams.fingerprint = options.fingerprint;

    // Prepare body with defaults
    const body = {
      userAgent: options.userAgent || DEFAULT_BROWSER_OPTIONS.userAgent,
      platform: options.platform || DEFAULT_BROWSER_OPTIONS.platform,
      screen: options.screen || DEFAULT_BROWSER_OPTIONS.screen,
      localization: options.localization || DEFAULT_BROWSER_OPTIONS.localization,
    };

    return this.client.request<CreateSessionResponse>('GET', '/api/v2/browser', {
      query: queryParams,
      body,
    });
  }

  /**
   * Get all running browser sessions
   * Based on: GET /browser/running
   */
  async getRunningSessions(): Promise<BrowserSession[]> {
    return this.client.request<BrowserSession[]>('GET', '/browser/running');
  }

  /**
   * Get live preview URL for a session
   * Based on: GET /browser/{taskId}/live
   */
  async getLiveUrl(taskId: string): Promise<string> {
    const response = await this.client.request<string>('GET', `/browser/${taskId}/live`);
    return response;
  }

  /**
   * Connect to browser session via WebSocket
   * Based on: WSS /browser/{taskId}
   */
  createWebSocketConnection(taskId: string): string {
    return this.client.createWebSocketUrl(`/browser/${taskId}`);
  }

  /**
   * Get the latest running session
   */
  async getLatestSession(): Promise<BrowserSession | null> {
    const sessions = await this.getRunningSessions();

    // Filter for processing sessions and sort by creation time
    const runningSessions = sessions
      .filter((session) => session.state === 'processing')
      .sort((a, b) => new Date(b.createTime).getTime() - new Date(a.createTime).getTime());

    return runningSessions.length > 0 ? runningSessions[0] : null;
  }

  /**
   * Wait for session to be ready (polling)
   */
  async waitForSession(taskId: string, maxWaitTime: number = 30000): Promise<BrowserSession> {
    const startTime = Date.now();
    const pollInterval = 1000; // 1 second

    while (Date.now() - startTime < maxWaitTime) {
      const sessions = await this.getRunningSessions();
      const session = sessions.find((s) => s.taskId === taskId);

      if (session && session.state === 'processing') {
        return session;
      }

      if (session && session.state === 'failed') {
        throw new Error(`Session ${taskId} failed to start`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Session ${taskId} did not become ready within ${maxWaitTime}ms`);
  }
}
