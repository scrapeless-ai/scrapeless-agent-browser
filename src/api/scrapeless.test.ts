/**
 * Tests for Main Scrapeless API
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScrapelessAPI } from './scrapeless.js';
import type { UserInfo } from './types.js';

describe('ScrapelessAPI', () => {
  const mockApiKey = 'sk_test_1234567890abcdef';
  let api: ScrapelessAPI;

  beforeEach(() => {
    process.env.SCRAPELESS_API_KEY = mockApiKey;
  });

  describe('constructor', () => {
    it('should initialize all sub-APIs', () => {
      api = new ScrapelessAPI({ apiKey: mockApiKey });

      expect(api.browser).toBeDefined();
      expect(api.user).toBeDefined();
    });

    it('should use environment variable for API key', () => {
      api = new ScrapelessAPI();

      expect(api).toBeDefined();
      expect(api.browser).toBeDefined();
    });
  });

  describe('getClient', () => {
    it('should return the underlying client', () => {
      api = new ScrapelessAPI({ apiKey: mockApiKey });

      const client = api.getClient();

      expect(client).toBeDefined();
      expect(client.getApiKey()).toContain('sk_test_');
    });
  });

  describe('testConnection', () => {
    it('should return true when connection succeeds', async () => {
      api = new ScrapelessAPI({ apiKey: mockApiKey });

      // Mock successful user info request
      const mockUserInfo: UserInfo = {
        credits: '100.00',
        excessCredits: '10.00',
        plan: {
          credits: '1000.00',
          endAt: '2024-12-31T23:59:59Z',
          price: 99,
          status: 1,
          usage: 500,
        },
        status: 1,
        userId: 'user123',
      };

      vi.spyOn(api.user, 'getUserInfo').mockResolvedValue(mockUserInfo);

      const result = await api.testConnection();

      expect(result).toBe(true);
    });

    it('should return false when connection fails', async () => {
      api = new ScrapelessAPI({ apiKey: mockApiKey });

      // Mock failed user info request
      vi.spyOn(api.user, 'getUserInfo').mockRejectedValue(new Error('Connection failed'));

      const result = await api.testConnection();

      expect(result).toBe(false);
    });
  });
});
