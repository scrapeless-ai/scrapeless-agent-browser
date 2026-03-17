/**
 * Tests for Scrapeless Browser API
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScrapelessClient } from './client.js';
import { ScrapelessBrowserAPI } from './browser.js';
import type { BrowserSession, CreateSessionResponse } from './types.js';

describe('ScrapelessBrowserAPI', () => {
  let mockClient: ScrapelessClient;
  let browserAPI: ScrapelessBrowserAPI;

  beforeEach(() => {
    // Create a mock client
    mockClient = {
      request: vi.fn(),
      createWebSocketUrl: vi.fn(),
    } as any;

    browserAPI = new ScrapelessBrowserAPI(mockClient);
  });

  describe('createSession', () => {
    it('should create session with default options', async () => {
      const mockResponse: CreateSessionResponse = {
        success: true,
        taskId: 'task123',
      };

      vi.mocked(mockClient.request).mockResolvedValue(mockResponse);

      const result = await browserAPI.createSession();

      expect(result).toEqual(mockResponse);
      expect(mockClient.request).toHaveBeenCalledWith(
        'GET',
        '/api/v2/browser',
        expect.objectContaining({
          body: expect.objectContaining({
            userAgent: expect.any(String),
            platform: expect.any(String),
            screen: expect.any(Object),
            localization: expect.any(Object),
          }),
        })
      );
    });

    it('should create session with custom options', async () => {
      const mockResponse: CreateSessionResponse = {
        success: true,
        taskId: 'task123',
      };

      vi.mocked(mockClient.request).mockResolvedValue(mockResponse);

      const options = {
        sessionName: 'test-session',
        sessionTTL: 600,
        proxyCountry: 'US',
        proxyState: 'CA',
        userAgent: 'Custom User Agent',
      };

      const result = await browserAPI.createSession(options);

      expect(result).toEqual(mockResponse);
      expect(mockClient.request).toHaveBeenCalledWith(
        'GET',
        '/api/v2/browser',
        expect.objectContaining({
          query: expect.objectContaining({
            sessionName: 'test-session',
            sessionTTL: 600,
            proxyCountry: 'US',
            proxyState: 'CA',
          }),
          body: expect.objectContaining({
            userAgent: 'Custom User Agent',
          }),
        })
      );
    });
  });

  describe('getRunningSessions', () => {
    it('should get all running sessions', async () => {
      const mockSessions: BrowserSession[] = [
        {
          taskId: 'task1',
          state: 'processing',
          createTime: '2024-01-01T00:00:00Z',
          expireTime: '2024-01-01T01:00:00Z',
          success: true,
        },
        {
          taskId: 'task2',
          state: 'processing',
          createTime: '2024-01-01T00:05:00Z',
          expireTime: '2024-01-01T01:05:00Z',
          success: true,
        },
      ];

      vi.mocked(mockClient.request).mockResolvedValue(mockSessions);

      const result = await browserAPI.getRunningSessions();

      expect(result).toEqual(mockSessions);
      expect(mockClient.request).toHaveBeenCalledWith('GET', '/browser/running');
    });

    it('should return empty array when no sessions', async () => {
      vi.mocked(mockClient.request).mockResolvedValue([]);

      const result = await browserAPI.getRunningSessions();

      expect(result).toEqual([]);
    });
  });

  describe('getLiveUrl', () => {
    it('should get live preview URL', async () => {
      const mockUrl = 'https://live.scrapeless.com/session/task123';
      vi.mocked(mockClient.request).mockResolvedValue(mockUrl);

      const result = await browserAPI.getLiveUrl('task123');

      expect(result).toBe(mockUrl);
      expect(mockClient.request).toHaveBeenCalledWith('GET', '/browser/task123/live');
    });
  });

  describe('createWebSocketConnection', () => {
    it('should create WebSocket connection URL', () => {
      const mockWsUrl = 'wss://api.scrapeless.com/browser/task123?token=xxx';
      vi.mocked(mockClient.createWebSocketUrl).mockReturnValue(mockWsUrl);

      const result = browserAPI.createWebSocketConnection('task123');

      expect(result).toBe(mockWsUrl);
      expect(mockClient.createWebSocketUrl).toHaveBeenCalledWith('/browser/task123');
    });
  });

  describe('getLatestSession', () => {
    it('should return the latest processing session', async () => {
      const mockSessions: BrowserSession[] = [
        {
          taskId: 'task1',
          state: 'processing',
          createTime: '2024-01-01T00:00:00Z',
          expireTime: '2024-01-01T01:00:00Z',
          success: true,
        },
        {
          taskId: 'task2',
          state: 'processing',
          createTime: '2024-01-01T00:05:00Z',
          expireTime: '2024-01-01T01:05:00Z',
          success: true,
        },
        {
          taskId: 'task3',
          state: 'completed',
          createTime: '2024-01-01T00:10:00Z',
          expireTime: '2024-01-01T01:10:00Z',
          success: true,
        },
      ];

      vi.mocked(mockClient.request).mockResolvedValue(mockSessions);

      const result = await browserAPI.getLatestSession();

      expect(result?.taskId).toBe('task2'); // Latest processing session
    });

    it('should return null when no processing sessions', async () => {
      const mockSessions: BrowserSession[] = [
        {
          taskId: 'task1',
          state: 'completed',
          createTime: '2024-01-01T00:00:00Z',
          expireTime: '2024-01-01T01:00:00Z',
          success: true,
        },
      ];

      vi.mocked(mockClient.request).mockResolvedValue(mockSessions);

      const result = await browserAPI.getLatestSession();

      expect(result).toBeNull();
    });

    it('should return null when no sessions at all', async () => {
      vi.mocked(mockClient.request).mockResolvedValue([]);

      const result = await browserAPI.getLatestSession();

      expect(result).toBeNull();
    });
  });

  describe('waitForSession', () => {
    it('should wait for session to be ready', async () => {
      const mockSession: BrowserSession = {
        taskId: 'task123',
        state: 'processing',
        createTime: '2024-01-01T00:00:00Z',
        expireTime: '2024-01-01T01:00:00Z',
        success: true,
      };

      vi.mocked(mockClient.request).mockResolvedValue([mockSession]);

      const result = await browserAPI.waitForSession('task123', 5000);

      expect(result).toEqual(mockSession);
    });

    it('should throw error if session fails', async () => {
      const mockSession: BrowserSession = {
        taskId: 'task123',
        state: 'failed',
        createTime: '2024-01-01T00:00:00Z',
        expireTime: '2024-01-01T01:00:00Z',
        success: false,
      };

      vi.mocked(mockClient.request).mockResolvedValue([mockSession]);

      await expect(browserAPI.waitForSession('task123', 5000)).rejects.toThrow(
        'Session task123 failed to start'
      );
    });

    it('should throw error if timeout exceeded', async () => {
      vi.mocked(mockClient.request).mockResolvedValue([]);

      await expect(browserAPI.waitForSession('task123', 1000)).rejects.toThrow(
        'Session task123 did not become ready within 1000ms'
      );
    }, 10000);
  });
});
