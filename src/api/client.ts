/**
 * Base Scrapeless API Client
 * Handles authentication, request/response processing, and error handling
 */

import { ScrapelessAPIError, ScrapelessConfigError } from './errors.js';
import { ScrapelessResponse } from './types.js';

export interface ClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
}

export class ScrapelessClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(options: ClientOptions = {}) {
    this.apiKey = options.apiKey || process.env.SCRAPELESS_API_KEY || '';
    this.baseUrl = options.baseUrl || 'https://api.scrapeless.com';
    this.timeout = options.timeout || 30000;

    if (!this.apiKey) {
      throw new ScrapelessConfigError(
        'API key is required. Set SCRAPELESS_API_KEY environment variable or pass apiKey option.'
      );
    }
  }

  /**
   * Make an authenticated HTTP request
   */
  async request<T = any>(
    method: string,
    path: string,
    options: {
      query?: Record<string, any>;
      body?: any;
      headers?: Record<string, string>;
    } = {}
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);

    // Add query parameters
    if (options.query) {
      Object.entries(options.query).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          if (Array.isArray(value)) {
            value.forEach((v) => url.searchParams.append(key, String(v)));
          } else {
            url.searchParams.set(key, String(value));
          }
        }
      });
    }

    const headers: Record<string, string> = {
      'x-api-token': this.apiKey,
      'Content-Type': 'application/json',
      'User-Agent': 'scrapeless-scraping-browser/0.1.0',
      ...options.headers,
    };

    const requestInit: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeout),
    };

    if (options.body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      requestInit.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(url.toString(), requestInit);

      if (!response.ok) {
        let errorBody;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = await response.text();
        }
        throw ScrapelessAPIError.fromResponse(response, errorBody);
      }

      const result = await response.json();

      // Handle Scrapeless API response format: { code, data, message }
      if (typeof result === 'object' && result !== null && 'code' in result) {
        const scrapelessResponse = result as ScrapelessResponse<T>;

        if (scrapelessResponse.code === 200) {
          return scrapelessResponse.data;
        } else {
          throw ScrapelessAPIError.fromScrapelessResponse(scrapelessResponse);
        }
      }

      // Return raw response if not in Scrapeless format
      return result as T;
    } catch (error) {
      if (error instanceof ScrapelessAPIError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new ScrapelessAPIError(`Request timeout after ${this.timeout}ms`, 408);
        }
        throw new ScrapelessAPIError(`Network error: ${error.message}`, 0);
      }

      throw new ScrapelessAPIError('Unknown error occurred', 500);
    }
  }

  /**
   * Create WebSocket connection URL
   */
  createWebSocketUrl(path: string, query: Record<string, any> = {}): string {
    const wsUrl = this.baseUrl.replace(/^https?:/, 'wss:');
    const url = new URL(path, wsUrl);

    // Add token to query parameters for WebSocket auth
    query.token = this.apiKey;

    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });

    return url.toString();
  }

  /**
   * Get API key (for debugging/testing)
   */
  getApiKey(): string {
    return this.apiKey.substring(0, 8) + '...';
  }
}
