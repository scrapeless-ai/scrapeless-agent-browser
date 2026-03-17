/**
 * Session caching for Scrapeless Browser Skills
 * Reduces API calls by caching active session information
 */

import { logger } from './logger.js';
import type { SessionInfo } from './api-client.js';

export interface CachedSession {
  sessionId: string;
  createdAt: Date;
  status: string;
  name?: string;
  metadata?: Record<string, any>;
  lastUsed: Date;
  cdpUrl?: string;
}

export class SessionCache {
  private static instance: SessionCache;
  private cache: Map<string, CachedSession> = new Map();
  private maxAge: number = 5 * 60 * 1000; // 5 minutes default
  private maxSize: number = 50; // Maximum number of cached sessions

  private constructor() {}

  static getInstance(): SessionCache {
    if (!SessionCache.instance) {
      SessionCache.instance = new SessionCache();
    }
    return SessionCache.instance;
  }

  /**
   * Set cache configuration
   */
  configure(options: { maxAge?: number; maxSize?: number }): void {
    if (options.maxAge !== undefined) {
      this.maxAge = options.maxAge;
    }
    if (options.maxSize !== undefined) {
      this.maxSize = options.maxSize;
    }
    logger.debug('Session cache configured', { maxAge: this.maxAge, maxSize: this.maxSize });
  }

  /**
   * Add or update a session in the cache
   */
  set(sessionInfo: SessionInfo, cdpUrl?: string): void {
    const cached: CachedSession = {
      sessionId: sessionInfo.sessionId,
      createdAt: new Date(sessionInfo.createdAt),
      status: sessionInfo.status,
      name: sessionInfo.name,
      metadata: sessionInfo.metadata,
      lastUsed: new Date(),
      cdpUrl,
    };

    this.cache.set(sessionInfo.sessionId, cached);
    this.cleanup();

    logger.debug('Session cached', {
      sessionId: sessionInfo.sessionId,
      status: sessionInfo.status,
    });
  }

  /**
   * Get a session from the cache
   */
  get(sessionId: string): CachedSession | null {
    const cached = this.cache.get(sessionId);

    if (!cached) {
      return null;
    }

    // Check if expired
    if (this.isExpired(cached)) {
      this.cache.delete(sessionId);
      logger.debug('Expired session removed from cache', { sessionId });
      return null;
    }

    // Update last used time
    cached.lastUsed = new Date();

    logger.debug('Session retrieved from cache', { sessionId, status: cached.status });
    return cached;
  }

  /**
   * Get all cached sessions
   */
  getAll(): CachedSession[] {
    this.cleanup();
    return Array.from(this.cache.values());
  }

  /**
   * Get all running sessions from cache
   */
  getRunning(): CachedSession[] {
    return this.getAll().filter((session) => session.status === 'running');
  }

  /**
   * Get the latest running session from cache
   */
  getLatestRunning(): CachedSession | null {
    const running = this.getRunning();
    if (running.length === 0) {
      return null;
    }

    // Sort by createdAt descending
    running.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return running[0];
  }

  /**
   * Remove a session from the cache
   */
  remove(sessionId: string): void {
    const removed = this.cache.delete(sessionId);
    if (removed) {
      logger.debug('Session removed from cache', { sessionId });
    }
  }

  /**
   * Update session status
   */
  updateStatus(sessionId: string, status: string): void {
    const cached = this.cache.get(sessionId);
    if (cached) {
      cached.status = status;
      cached.lastUsed = new Date();
      logger.debug('Session status updated in cache', { sessionId, status });
    }
  }

  /**
   * Clear all cached sessions
   */
  clear(): void {
    const count = this.cache.size;
    this.cache.clear();
    logger.debug('Session cache cleared', { removedCount: count });
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    total: number;
    running: number;
    expired: number;
    oldestEntry: Date | null;
    newestEntry: Date | null;
  } {
    const all = Array.from(this.cache.values());
    const running = all.filter((s) => s.status === 'running');
    const expired = all.filter((s) => this.isExpired(s));

    const dates = all.map((s) => s.lastUsed);
    const oldestEntry =
      dates.length > 0 ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
    const newestEntry =
      dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;

    return {
      total: all.length,
      running: running.length,
      expired: expired.length,
      oldestEntry,
      newestEntry,
    };
  }

  /**
   * Check if a cached session is expired
   */
  private isExpired(cached: CachedSession): boolean {
    const now = new Date();
    const age = now.getTime() - cached.lastUsed.getTime();
    return age > this.maxAge;
  }

  /**
   * Clean up expired sessions and enforce size limit
   */
  private cleanup(): void {
    const now = new Date();
    let removedCount = 0;

    // Remove expired sessions
    for (const [sessionId, cached] of this.cache.entries()) {
      if (this.isExpired(cached)) {
        this.cache.delete(sessionId);
        removedCount++;
      }
    }

    // Enforce size limit by removing oldest entries
    if (this.cache.size > this.maxSize) {
      const entries = Array.from(this.cache.entries());
      entries.sort(([, a], [, b]) => a.lastUsed.getTime() - b.lastUsed.getTime());

      const toRemove = entries.slice(0, this.cache.size - this.maxSize);
      for (const [sessionId] of toRemove) {
        this.cache.delete(sessionId);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      logger.debug('Session cache cleanup completed', { removedCount, remaining: this.cache.size });
    }
  }
}

// Global session cache instance
export const sessionCache = SessionCache.getInstance();

/**
 * Configure the global session cache
 */
export function configureSessionCache(options: { maxAge?: number; maxSize?: number }): void {
  sessionCache.configure(options);
}
