/**
 * Session Manager for handling Scrapeless session lifecycle and connection management
 */

import { logger } from './logger.js';
import { getApiClient } from './api-client.js';
import { ScrapelessError, ScrapelessErrorType } from './errors.js';

export interface SessionInfo {
  sessionId: string;
  status: 'active' | 'terminated' | 'unknown';
  canReconnect: boolean;
  message?: string;
}

export class SessionManager {
  private static instance: SessionManager;
  private activeConnections: Map<string, boolean> = new Map();

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * Check if a session can be connected to
   */
  async checkSessionStatus(sessionId: string): Promise<SessionInfo> {
    try {
      // Check if we have an active connection to this session
      if (this.activeConnections.has(sessionId)) {
        return {
          sessionId,
          status: 'active',
          canReconnect: true,
          message: 'Session has an active connection',
        };
      }

      // Query the API to check if session exists and is running
      const apiClient = getApiClient();
      const sessionList = await apiClient.listSessions();

      const session = sessionList.sessions.find((s: any) => s.sessionId === sessionId);

      if (!session) {
        return {
          sessionId,
          status: 'unknown',
          canReconnect: false,
          message: 'Session not found in running sessions list',
        };
      }

      // Session exists but we don't have an active connection
      // This means it might be terminated if connection was previously closed
      return {
        sessionId,
        status: 'terminated',
        canReconnect: false,
        message:
          'Session exists but connection was closed. Scrapeless sessions terminate when disconnected.',
      };
    } catch (error) {
      logger.warn('Failed to check session status', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        sessionId,
        status: 'unknown',
        canReconnect: false,
        message: `Failed to check session status: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Mark a session as having an active connection
   */
  markSessionActive(sessionId: string): void {
    this.activeConnections.set(sessionId, true);
    logger.debug('Marked session as active', { sessionId });
  }

  /**
   * Mark a session as disconnected
   */
  markSessionDisconnected(sessionId: string): void {
    this.activeConnections.delete(sessionId);
    logger.debug('Marked session as disconnected', { sessionId });
  }

  /**
   * Get user-friendly guidance for session connection issues
   */
  getSessionGuidance(sessionInfo: SessionInfo): string {
    switch (sessionInfo.status) {
      case 'active':
        return `Session ${sessionInfo.sessionId} is active and ready to use.`;

      case 'terminated':
        return (
          `Session ${sessionInfo.sessionId} has been terminated because the connection was closed. ` +
          `Scrapeless sessions automatically terminate when disconnected and cannot be reconnected. ` +
          `Please create a new session using: create --name <name> --ttl <seconds>`
        );

      case 'unknown':
        return (
          `Session ${sessionInfo.sessionId} status is unknown. ${sessionInfo.message || ''} ` +
          `Please check if the session exists using: sessions`
        );

      default:
        return `Session ${sessionInfo.sessionId} status is unclear. Please create a new session.`;
    }
  }

  /**
   * Validate session ID before attempting connection
   */
  async validateSessionForConnection(sessionId: string): Promise<void> {
    const sessionInfo = await this.checkSessionStatus(sessionId);

    if (!sessionInfo.canReconnect) {
      const guidance = this.getSessionGuidance(sessionInfo);
      throw new ScrapelessError(ScrapelessErrorType.SESSION_TERMINATED, guidance, {
        retryable: false,
      });
    }
  }
}
