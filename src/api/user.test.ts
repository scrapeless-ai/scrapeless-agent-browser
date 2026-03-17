/**
 * Tests for Scrapeless User API
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScrapelessClient } from './client.js';
import { ScrapelessUserAPI } from './user.js';
import type { UserInfo } from './types.js';

describe('ScrapelessUserAPI', () => {
  let mockClient: ScrapelessClient;
  let userAPI: ScrapelessUserAPI;

  beforeEach(() => {
    // Create a mock client
    mockClient = {
      request: vi.fn(),
    } as any;

    userAPI = new ScrapelessUserAPI(mockClient);
  });

  describe('getUserInfo', () => {
    it('should get user information', async () => {
      const mockUserInfo: UserInfo = {
        credits: '100.50',
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

      vi.mocked(mockClient.request).mockResolvedValue(mockUserInfo);

      const result = await userAPI.getUserInfo();

      expect(result).toEqual(mockUserInfo);
      expect(mockClient.request).toHaveBeenCalledWith('GET', '/user/info');
    });
  });

  describe('getCredits', () => {
    it('should return credits as number', async () => {
      const mockUserInfo: UserInfo = {
        credits: '150.75',
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

      vi.mocked(mockClient.request).mockResolvedValue(mockUserInfo);

      const result = await userAPI.getCredits();

      expect(result).toBe(150.75);
    });

    it('should handle zero credits', async () => {
      const mockUserInfo: UserInfo = {
        credits: '0',
        excessCredits: '0',
        plan: {
          credits: '0',
          endAt: '2024-12-31T23:59:59Z',
          price: 0,
          status: 0,
          usage: 0,
        },
        status: 1,
        userId: 'user123',
      };

      vi.mocked(mockClient.request).mockResolvedValue(mockUserInfo);

      const result = await userAPI.getCredits();

      expect(result).toBe(0);
    });
  });

  describe('hasCredits', () => {
    it('should return true when credits are sufficient', async () => {
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

      vi.mocked(mockClient.request).mockResolvedValue(mockUserInfo);

      const result = await userAPI.hasCredits(10);

      expect(result).toBe(true);
    });

    it('should return false when credits are insufficient', async () => {
      const mockUserInfo: UserInfo = {
        credits: '5.00',
        excessCredits: '0',
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

      vi.mocked(mockClient.request).mockResolvedValue(mockUserInfo);

      const result = await userAPI.hasCredits(10);

      expect(result).toBe(false);
    });

    it('should use default minimum credits of 0.1', async () => {
      const mockUserInfo: UserInfo = {
        credits: '0.05',
        excessCredits: '0',
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

      vi.mocked(mockClient.request).mockResolvedValue(mockUserInfo);

      const result = await userAPI.hasCredits();

      expect(result).toBe(false);
    });

    it('should return true when credits exactly match minimum', async () => {
      const mockUserInfo: UserInfo = {
        credits: '10.00',
        excessCredits: '0',
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

      vi.mocked(mockClient.request).mockResolvedValue(mockUserInfo);

      const result = await userAPI.hasCredits(10);

      expect(result).toBe(true);
    });
  });
});
