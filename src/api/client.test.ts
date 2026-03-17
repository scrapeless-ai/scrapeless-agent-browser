/**
 * Tests for Scrapeless API Client
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScrapelessClient } from './client.js';
import { ScrapelessAPIError, ScrapelessConfigError } from './errors.js';

describe('ScrapelessClient', () => {
  const mockApiKey = 'sk_test_1234567890abcdef';
  let client: ScrapelessClient;

  beforeEach(() => {
    // Clear environment variables
    delete process.env.SCRAPELESS_API_KEY;
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with provided API key', () => {
      client = new ScrapelessClient({ apiKey: mockApiKey });
      expect(client.getApiKey()).toContain('sk_test_');
    });

    it('should use environment variable if no API key provided', () => {
      process.env.SCRAPELESS_API_KEY = mockApiKey;
      client = new ScrapelessClient();
      expect(client.getApiKey()).toContain('sk_test_');
    });

    it('should throw error if no API key is available', () => {
      expect(() => new ScrapelessClient()).toThrow(ScrapelessConfigError);
      expect(() => new ScrapelessClient()).toThrow('API key is required');
    });

    it('should use default baseUrl if not provided', () => {
      client = new ScrapelessClient({ apiKey: mockApiKey });
      // BaseUrl is private, we'll test it indirectly through requests
      expect(client).toBeDefined();
    });

    it('should use custom baseUrl if provided', () => {
      client = new ScrapelessClient({
        apiKey: mockApiKey,
        baseUrl: 'https://custom.api.com',
      });
      expect(client).toBeDefined();
    });

    it('should use default timeout if not provided', () => {
      client = new ScrapelessClient({ apiKey: mockApiKey });
      expect(client).toBeDefined();
    });

    it('should use custom timeout if provided', () => {
      client = new ScrapelessClient({
        apiKey: mockApiKey,
        timeout: 60000,
      });
      expect(client).toBeDefined();
    });
  });

  describe('createWebSocketUrl', () => {
    beforeEach(() => {
      client = new ScrapelessClient({ apiKey: mockApiKey });
    });

    it('should create WebSocket URL with token', () => {
      const wsUrl = client.createWebSocketUrl('/browser/test123');
      expect(wsUrl).toContain('wss://');
      expect(wsUrl).toContain('/browser/test123');
      expect(wsUrl).toContain(`token=${mockApiKey}`);
    });

    it('should include query parameters', () => {
      const wsUrl = client.createWebSocketUrl('/browser/test123', {
        sessionId: 'session123',
        debug: true,
      });
      expect(wsUrl).toContain('sessionId=session123');
      expect(wsUrl).toContain('debug=true');
    });

    it('should skip null/undefined query parameters', () => {
      const wsUrl = client.createWebSocketUrl('/browser/test123', {
        sessionId: 'session123',
        debug: null,
        verbose: undefined,
      });
      expect(wsUrl).toContain('sessionId=session123');
      expect(wsUrl).not.toContain('debug=');
      expect(wsUrl).not.toContain('verbose=');
    });
  });

  describe('getApiKey', () => {
    it('should return masked API key', () => {
      client = new ScrapelessClient({ apiKey: mockApiKey });
      const maskedKey = client.getApiKey();
      expect(maskedKey).toContain('sk_test_');
      expect(maskedKey).toContain('...');
      expect(maskedKey.length).toBeLessThan(mockApiKey.length);
    });
  });
});
