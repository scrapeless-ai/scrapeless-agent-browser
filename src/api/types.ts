/**
 * Type definitions for Scrapeless API
 * Based on official API documentation
 */

// Base API response format
export interface ScrapelessResponse<T = any> {
  code: number;
  data: T;
  message: string;
}

// User API types
export interface UserInfo {
  credits: string;
  excessCredits: string;
  plan: {
    credits: string;
    endAt: string;
    price: number;
    status: number;
    usage: number;
  };
  status: number;
  userId: string;
}

// Browser API types
export interface BrowserSessionOptions {
  // Query parameters
  sessionTTL?: number;
  sessionName?: string;
  sessionRecording?: boolean;
  proxyURL?: string;
  proxyCountry?: string;
  proxyState?: string;
  proxyCity?: string;
  extensionIds?: string[];
  fingerprint?: string;

  // Body parameters
  userAgent?: string;
  platform?: string;
  screen?: {
    width: number;
    height: number;
  };
  localization?: {
    basedOnIP: boolean;
    timezone: string;
    languages: string[];
  };
}

export interface BrowserSession {
  taskId: string;
  state: 'processing' | 'completed' | 'failed';
  createTime: string;
  expireTime: string;
  success: boolean;
  metadata?: {
    session_name?: string;
    [key: string]: any;
  };
}

export interface CreateSessionResponse {
  success: boolean;
  taskId: string;
}

export interface LiveUrlResponse {
  url: string;
}

// Default values
export const DEFAULT_BROWSER_OPTIONS: Required<
  Pick<BrowserSessionOptions, 'userAgent' | 'platform' | 'screen' | 'localization'>
> = {
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.1.2.3 Safari/537.36',
  platform: 'Windows',
  screen: {
    width: 1920,
    height: 1080,
  },
  localization: {
    basedOnIP: false,
    timezone: 'America/New_York',
    languages: ['en'],
  },
};
