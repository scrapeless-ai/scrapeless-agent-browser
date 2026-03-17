import {
  chromium,
  firefox,
  webkit,
  devices,
  type Browser,
  type BrowserContext,
  type Page,
  type Frame,
  type Dialog,
  type Request,
  type Route,
  type Locator,
  type CDPSession,
  type Video,
} from 'playwright-core';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync, rmSync, readFileSync, statSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { getApiKey, getConfigValue } from './config.js';
import type { LaunchCommand, TraceEvent } from './types.js';
import { type RefMap, type EnhancedSnapshot, getEnhancedSnapshot, parseRef } from './snapshot.js';
import { safeHeaderMerge } from './state-utils.js';
import { isDomainAllowed, installDomainFilter, parseDomainList } from './domain-filter.js';
import {
  getEncryptionKey,
  isEncryptedPayload,
  decryptData,
  ENCRYPTION_KEY_ENV,
} from './state-utils.js';
import { ScrapelessError, ScrapelessErrorType, withRetry } from './errors.js';
import { logger } from './logger.js';
import { getApiClient, type SessionCreateParams } from './api-client.js';
import { sessionCache } from './session-cache.js';
import { SessionManager } from './session-manager.js';

/**
 * Returns the default Playwright timeout in milliseconds for standard operations.
 * Can be overridden via the SCRAPELESS_BROWSER_DEFAULT_TIMEOUT environment variable.
 * Default is 25s, which is below the CLI's 30s IPC read timeout to ensure
 * Playwright errors are returned before the CLI gives up with EAGAIN.
 * CDP and recording contexts use a shorter fixed timeout (10s) and are not affected.
 */
export function getDefaultTimeout(): number {
  const envValue = process.env.SCRAPELESS_BROWSER_DEFAULT_TIMEOUT;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed >= 1000) {
      return parsed;
    }
  }
  return 25000;
}

// Screencast frame data from CDP
export interface ScreencastFrame {
  data: string; // base64 encoded image
  metadata: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
    timestamp?: number;
  };
  sessionId: number;
}

// Screencast options
export interface ScreencastOptions {
  format?: 'jpeg' | 'png';
  quality?: number; // 0-100, only for jpeg
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}

interface TrackedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  timestamp: number;
  resourceType: string;
}

interface ConsoleMessage {
  type: string;
  text: string;
  timestamp: number;
}

interface PageError {
  message: string;
  timestamp: number;
}

/**
 * Manages the Playwright browser lifecycle with multiple tabs/windows
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private cdpEndpoint: string | null = null; // stores port number or full URL
  private isPersistentContext: boolean = false;
  private scrapelessSessionId: string | null = null; // Current Scrapeless session ID
  private contexts: BrowserContext[] = [];
  private pages: Page[] = [];
  private activePageIndex: number = 0;
  private activeFrame: Frame | null = null;
  private dialogHandler: ((dialog: Dialog) => Promise<void>) | null = null;
  private trackedRequests: TrackedRequest[] = [];
  private routes: Map<string, (route: Route) => Promise<void>> = new Map();
  private consoleMessages: ConsoleMessage[] = [];
  private pageErrors: PageError[] = [];
  private isRecordingHar: boolean = false;
  private refMap: RefMap = {};
  private lastSnapshot: string = '';
  private scopedHeaderRoutes: Map<string, (route: Route) => Promise<void>> = new Map();
  private colorScheme: 'light' | 'dark' | 'no-preference' | null = null;
  private downloadPath: string | null = null;
  private allowedDomains: string[] = [];

  /**
   * Set the persistent color scheme preference.
   * Applied automatically to all new pages and contexts.
   */
  setColorScheme(scheme: 'light' | 'dark' | 'no-preference' | null): void {
    this.colorScheme = scheme;
  }

  // CDP session for screencast and input injection
  private cdpSession: CDPSession | null = null;
  private screencastActive: boolean = false;
  private screencastSessionId: number = 0;
  private frameCallback: ((frame: ScreencastFrame) => void) | null = null;
  private screencastFrameHandler: ((params: any) => void) | null = null;

  // Video recording (Playwright native)
  private recordingContext: BrowserContext | null = null;
  private recordingPage: Page | null = null;
  private recordingOutputPath: string = '';
  private recordingTempDir: string = '';
  private launchWarnings: string[] = [];

  /**
   * Get and clear launch warnings (e.g., decryption failures)
   */
  getAndClearWarnings(): string[] {
    const warnings = this.launchWarnings;
    this.launchWarnings = [];
    return warnings;
  }

  // CDP profiling state
  private static readonly MAX_PROFILE_EVENTS = 5_000_000;
  private profilingActive: boolean = false;
  private profileChunks: TraceEvent[] = [];
  private profileEventsDropped: boolean = false;
  private profileCompleteResolver: (() => void) | null = null;
  private profileDataHandler: ((params: { value?: TraceEvent[] }) => void) | null = null;
  private profileCompleteHandler: (() => void) | null = null;

  /**
   * Check if browser is launched
   */
  isLaunched(): boolean {
    return this.browser !== null || this.isPersistentContext;
  }

  /**
   * Get enhanced snapshot with refs and cache the ref map
   */
  async getSnapshot(options?: {
    interactive?: boolean;
    cursor?: boolean;
    maxDepth?: number;
    compact?: boolean;
    selector?: string;
  }): Promise<EnhancedSnapshot> {
    const page = this.getPage();
    const snapshot = await getEnhancedSnapshot(page, options);
    this.refMap = snapshot.refs;
    this.lastSnapshot = snapshot.tree;
    return snapshot;
  }

  /**
   * Get the last snapshot tree text (empty string if no snapshot has been taken)
   */
  getLastSnapshot(): string {
    return this.lastSnapshot;
  }

  /**
   * Update the stored snapshot (used by diff to keep the baseline current)
   */
  setLastSnapshot(snapshot: string): void {
    this.lastSnapshot = snapshot;
  }

  /**
   * Get the cached ref map from last snapshot
   */
  getRefMap(): RefMap {
    return this.refMap;
  }

  /**
   * Get a locator from a ref (e.g., "e1", "@e1", "ref=e1")
   * Returns null if ref doesn't exist or is invalid
   */
  getLocatorFromRef(refArg: string): Locator | null {
    const ref = parseRef(refArg);
    if (!ref) return null;

    const refData = this.refMap[ref];
    if (!refData) return null;

    const page = this.getPage();

    // Check if this is a cursor-interactive element (uses CSS selector, not ARIA role)
    // These have pseudo-roles 'clickable' or 'focusable' and a CSS selector
    if (refData.role === 'clickable' || refData.role === 'focusable') {
      // The selector is a CSS selector, use it directly
      return page.locator(refData.selector);
    }

    // Build locator with exact: true to avoid substring matches
    let locator: Locator = page.getByRole(refData.role as any, {
      name: refData.name,
      exact: true,
    });

    // If an nth index is stored (for disambiguation), use it
    if (refData.nth !== undefined) {
      locator = locator.nth(refData.nth);
    }

    return locator;
  }

  /**
   * Check if a selector looks like a ref
   */
  isRef(selector: string): boolean {
    return parseRef(selector) !== null;
  }

  /**
   * Install the domain filter on a context if an allowlist is configured.
   * Should be called before any pages navigate on the context.
   */
  private async ensureDomainFilter(context: BrowserContext): Promise<void> {
    if (this.allowedDomains.length > 0) {
      await installDomainFilter(context, this.allowedDomains);
    }
  }

  /**
   * After installing the domain filter, verify existing pages are on allowed
   * domains. Pages that pre-date the filter (e.g. CDP/cloud connect) may have
   * already navigated to disallowed domains. Navigate them to about:blank.
   */
  private async sanitizeExistingPages(pages: Page[]): Promise<void> {
    if (this.allowedDomains.length === 0) return;
    for (const page of pages) {
      const url = page.url();
      if (!url || url === 'about:blank') continue;
      try {
        const hostname = new URL(url).hostname.toLowerCase();
        if (!isDomainAllowed(hostname, this.allowedDomains)) {
          await page.goto('about:blank');
        }
      } catch {
        await page.goto('about:blank').catch(() => {});
      }
    }
  }

  /**
   * Check if a URL is allowed by the domain allowlist.
   * Throws if the URL's domain is blocked. No-op if no allowlist is set.
   * Blocks non-http(s) schemes and unparseable URLs by default.
   */
  checkDomainAllowed(url: string): void {
    if (this.allowedDomains.length === 0) return;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error(`Navigation blocked: non-http(s) scheme in URL "${url}"`);
    }

    let hostname: string;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      throw new Error(`Navigation blocked: unable to parse URL "${url}"`);
    }

    if (!isDomainAllowed(hostname, this.allowedDomains)) {
      throw new Error(`Navigation blocked: ${hostname} is not in the allowed domains list`);
    }
  }

  /**
   * Get locator - supports both refs and regular selectors
   */
  getLocator(selectorOrRef: string): Locator {
    // Check if it's a ref first
    const locator = this.getLocatorFromRef(selectorOrRef);
    if (locator) return locator;

    // Otherwise treat as regular selector
    const page = this.getPage();
    return page.locator(selectorOrRef);
  }

  /**
   * Check if the browser has any usable pages
   */
  hasPages(): boolean {
    return this.pages.length > 0;
  }

  /**
   * Ensure at least one page exists. If the browser is launched but all pages
   * were closed (stale session), creates a new page on the existing context.
   * No-op if pages already exist.
   */
  async ensurePage(): Promise<void> {
    if (this.pages.length > 0) {
      // Check if current pages are still valid
      const validPages = this.pages.filter((p) => !p.isClosed());
      if (validPages.length > 0) {
        // Update pages list to only include valid pages
        this.pages = validPages;
        this.activePageIndex = Math.min(this.activePageIndex, this.pages.length - 1);
        return;
      }
      // All pages are closed, need to create new ones
      this.pages = [];
    }

    if (!this.browser && !this.isPersistentContext) return;

    // For Scrapeless sessions, try to use existing pages from existing contexts first
    if (this.scrapelessSessionId && this.browser) {
      const contexts = this.browser.contexts();
      logger.debug('Ensuring page for Scrapeless session', {
        contexts: contexts.length,
        sessionId: this.scrapelessSessionId,
      });

      for (const context of contexts) {
        const existingPages = context.pages().filter((p) => !p.isClosed());
        if (existingPages.length > 0) {
          // Use the first valid existing page
          const page = existingPages[0];
          if (!this.pages.includes(page)) {
            this.pages.push(page);
            this.setupPageTracking(page);
          }
          this.activePageIndex = this.pages.indexOf(page);
          logger.debug('Using existing Scrapeless page', {
            pageUrl: page.url(),
            activePageIndex: this.activePageIndex,
          });
          return;
        }
      }

      // For Scrapeless sessions, we should never create new pages
      // If no valid existing pages found, this indicates a session problem
      logger.error('No valid existing pages found in Scrapeless session contexts');
      throw new ScrapelessError(
        ScrapelessErrorType.CDP_ERROR,
        'No valid pages available in Scrapeless session contexts. The session may have expired or been terminated.'
      );
    }

    // Fallback logic for non-Scrapeless sessions or when Scrapeless page creation fails
    let context: BrowserContext;
    if (this.contexts.length > 0) {
      context = this.contexts[this.contexts.length - 1];
    } else if (this.browser) {
      context = await this.browser.newContext({
        ...(this.colorScheme && { colorScheme: this.colorScheme }),
      });
      context.setDefaultTimeout(getDefaultTimeout());
      this.contexts.push(context);
      this.setupContextTracking(context);
      await this.ensureDomainFilter(context);
    } else {
      return;
    }

    // For Scrapeless sessions, try to use existing pages in the context first
    if (this.scrapelessSessionId) {
      const existingPages = context.pages().filter((p) => !p.isClosed());
      if (existingPages.length > 0) {
        const page = existingPages[0];
        if (!this.pages.includes(page)) {
          this.pages.push(page);
          this.setupPageTracking(page);
        }
        this.activePageIndex = this.pages.indexOf(page);
        logger.debug('Using existing Scrapeless page from context', {
          pageUrl: page.url(),
          activePageIndex: this.activePageIndex,
        });
        return;
      }
    }

    // Last resort: create new page (only for non-Scrapeless sessions)
    if (this.scrapelessSessionId) {
      logger.error('No valid pages available in Scrapeless session');
      throw new ScrapelessError(
        ScrapelessErrorType.CDP_ERROR,
        'No valid pages available in Scrapeless session. The session may have expired or been terminated.'
      );
    }

    try {
      const page = await context.newPage();
      if (!this.pages.includes(page)) {
        this.pages.push(page);
        this.setupPageTracking(page);
      }
      this.activePageIndex = this.pages.length - 1;
      logger.debug('Created new page as last resort for regular browser session', {
        activePageIndex: this.activePageIndex,
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get the current active page, throws if not launched
   */
  getPage(): Page {
    if (this.pages.length === 0) {
      throw new Error('Browser not launched. Call launch first.');
    }

    // Check if current active page is still valid
    const currentPage = this.pages[this.activePageIndex];
    if (currentPage && !currentPage.isClosed()) {
      return currentPage;
    }

    // Current page is closed, find a valid page
    const validPages = this.pages.filter((p) => !p.isClosed());
    if (validPages.length === 0) {
      if (this.scrapelessSessionId) {
        throw new ScrapelessError(
          ScrapelessErrorType.CDP_ERROR,
          'All pages in Scrapeless session are closed. The session may have expired or been terminated.'
        );
      } else {
        throw new Error('All pages are closed. Browser may have been terminated.');
      }
    }

    // Update pages list and active index
    this.pages = validPages;
    this.activePageIndex = 0;

    logger.debug('Switched to valid page after current page was closed', {
      newActivePageUrl: this.pages[0].url(),
      remainingPages: this.pages.length,
    });

    return this.pages[0];
  }

  /**
   * Get the current frame (or page's main frame if no frame is selected)
   */
  getFrame(): Frame {
    if (this.activeFrame) {
      return this.activeFrame;
    }
    return this.getPage().mainFrame();
  }

  /**
   * Switch to a frame by selector, name, or URL
   */
  async switchToFrame(options: { selector?: string; name?: string; url?: string }): Promise<void> {
    const page = this.getPage();

    if (options.selector) {
      const frameElement = await page.$(options.selector);
      if (!frameElement) {
        throw new Error(`Frame not found: ${options.selector}`);
      }
      const frame = await frameElement.contentFrame();
      if (!frame) {
        throw new Error(`Element is not a frame: ${options.selector}`);
      }
      this.activeFrame = frame;
    } else if (options.name) {
      const frame = page.frame({ name: options.name });
      if (!frame) {
        throw new Error(`Frame not found with name: ${options.name}`);
      }
      this.activeFrame = frame;
    } else if (options.url) {
      const frame = page.frame({ url: options.url });
      if (!frame) {
        throw new Error(`Frame not found with URL: ${options.url}`);
      }
      this.activeFrame = frame;
    }
  }

  /**
   * Switch back to main frame
   */
  switchToMainFrame(): void {
    this.activeFrame = null;
  }

  /**
   * Set up dialog handler
   */
  setDialogHandler(response: 'accept' | 'dismiss', promptText?: string): void {
    const page = this.getPage();

    // Remove existing handler if any
    if (this.dialogHandler) {
      page.removeListener('dialog', this.dialogHandler);
    }

    this.dialogHandler = async (dialog: Dialog) => {
      if (response === 'accept') {
        await dialog.accept(promptText);
      } else {
        await dialog.dismiss();
      }
    };

    page.on('dialog', this.dialogHandler);
  }

  /**
   * Clear dialog handler
   */
  clearDialogHandler(): void {
    if (this.dialogHandler) {
      const page = this.getPage();
      page.removeListener('dialog', this.dialogHandler);
      this.dialogHandler = null;
    }
  }

  /**
   * Start tracking requests
   */
  startRequestTracking(): void {
    const page = this.getPage();
    page.on('request', (request: Request) => {
      this.trackedRequests.push({
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        timestamp: Date.now(),
        resourceType: request.resourceType(),
      });
    });
  }

  /**
   * Get tracked requests
   */
  getRequests(filter?: string): TrackedRequest[] {
    if (filter) {
      return this.trackedRequests.filter((r) => r.url.includes(filter));
    }
    return this.trackedRequests;
  }

  /**
   * Clear tracked requests
   */
  clearRequests(): void {
    this.trackedRequests = [];
  }

  /**
   * Add a route to intercept requests
   */
  async addRoute(
    url: string,
    options: {
      response?: {
        status?: number;
        body?: string;
        contentType?: string;
        headers?: Record<string, string>;
      };
      abort?: boolean;
    }
  ): Promise<void> {
    const page = this.getPage();

    const handler = async (route: Route) => {
      if (options.abort) {
        await route.abort();
      } else if (options.response) {
        await route.fulfill({
          status: options.response.status ?? 200,
          body: options.response.body ?? '',
          contentType: options.response.contentType ?? 'text/plain',
          headers: options.response.headers,
        });
      } else {
        await route.continue();
      }
    };

    this.routes.set(url, handler);
    await page.route(url, handler);
  }

  /**
   * Remove a route
   */
  async removeRoute(url?: string): Promise<void> {
    const page = this.getPage();

    if (url) {
      const handler = this.routes.get(url);
      if (handler) {
        await page.unroute(url, handler);
        this.routes.delete(url);
      }
    } else {
      // Remove all routes
      for (const [routeUrl, handler] of this.routes) {
        await page.unroute(routeUrl, handler);
      }
      this.routes.clear();
    }
  }

  /**
   * Set geolocation
   */
  async setGeolocation(latitude: number, longitude: number, accuracy?: number): Promise<void> {
    const context = this.contexts[0];
    if (context) {
      await context.setGeolocation({ latitude, longitude, accuracy });
    }
  }

  /**
   * Set permissions
   */
  async setPermissions(permissions: string[], grant: boolean): Promise<void> {
    const context = this.contexts[0];
    if (context) {
      if (grant) {
        await context.grantPermissions(permissions);
      } else {
        await context.clearPermissions();
      }
    }
  }

  /**
   * Set viewport
   */
  async setViewport(width: number, height: number): Promise<void> {
    const page = this.getPage();
    await page.setViewportSize({ width, height });
  }

  /**
   * Set device scale factor (devicePixelRatio) via CDP
   * This sets window.devicePixelRatio which affects how the page renders and responds to media queries
   *
   * Note: When using CDP to set deviceScaleFactor, screenshots will be at logical pixel dimensions
   * (viewport size), not physical pixel dimensions (viewport × scale). This is a Playwright limitation
   * when using CDP emulation on existing contexts. For true HiDPI screenshots with physical pixels,
   * deviceScaleFactor must be set at context creation time.
   *
   * Must be called after setViewport to work correctly
   */
  async setDeviceScaleFactor(
    deviceScaleFactor: number,
    width: number,
    height: number,
    mobile: boolean = false
  ): Promise<void> {
    const cdp = await this.getCDPSession();
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });
  }

  /**
   * Clear device metrics override to restore default devicePixelRatio
   */
  async clearDeviceMetricsOverride(): Promise<void> {
    const cdp = await this.getCDPSession();
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }

  /**
   * Get device descriptor
   */
  getDevice(deviceName: string): (typeof devices)[keyof typeof devices] | undefined {
    return devices[deviceName as keyof typeof devices];
  }

  /**
   * List available devices
   */
  listDevices(): string[] {
    return Object.keys(devices);
  }

  /**
   * Start console message tracking
   */
  startConsoleTracking(): void {
    const page = this.getPage();
    page.on('console', (msg) => {
      this.consoleMessages.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
    });
  }

  /**
   * Get console messages
   */
  getConsoleMessages(): ConsoleMessage[] {
    return this.consoleMessages;
  }

  /**
   * Clear console messages
   */
  clearConsoleMessages(): void {
    this.consoleMessages = [];
  }

  /**
   * Start error tracking
   */
  startErrorTracking(): void {
    const page = this.getPage();
    page.on('pageerror', (error) => {
      this.pageErrors.push({
        message: error.message,
        timestamp: Date.now(),
      });
    });
  }

  /**
   * Get page errors
   */
  getPageErrors(): PageError[] {
    return this.pageErrors;
  }

  /**
   * Clear page errors
   */
  clearPageErrors(): void {
    this.pageErrors = [];
  }

  /**
   * Start HAR recording
   */
  async startHarRecording(): Promise<void> {
    // HAR is started at context level, flag for tracking
    this.isRecordingHar = true;
  }

  /**
   * Check if HAR recording
   */
  isHarRecording(): boolean {
    return this.isRecordingHar;
  }

  /**
   * Set offline mode
   */
  async setOffline(offline: boolean): Promise<void> {
    const context = this.contexts[0];
    if (context) {
      await context.setOffline(offline);
    }
  }

  /**
   * Set extra HTTP headers (global - all requests)
   */
  async setExtraHeaders(headers: Record<string, string>): Promise<void> {
    const context = this.contexts[0];
    if (context) {
      await context.setExtraHTTPHeaders(headers);
    }
  }

  /**
   * Set scoped HTTP headers (only for requests matching the origin)
   * Uses route interception to add headers only to matching requests
   */
  async setScopedHeaders(origin: string, headers: Record<string, string>): Promise<void> {
    const page = this.getPage();

    // Build URL pattern from origin (e.g., "api.example.com" -> "**://api.example.com/**")
    // Handle both full URLs and just hostnames
    let urlPattern: string;
    try {
      const url = new URL(origin.startsWith('http') ? origin : `https://${origin}`);
      // Match any protocol, the host, and any path
      urlPattern = `**://${url.host}/**`;
    } catch {
      // If parsing fails, treat as hostname pattern
      urlPattern = `**://${origin}/**`;
    }

    // Remove existing route for this origin if any
    const existingHandler = this.scopedHeaderRoutes.get(urlPattern);
    if (existingHandler) {
      await page.unroute(urlPattern, existingHandler);
    }

    // Create handler that adds headers to matching requests
    const handler = async (route: Route) => {
      const requestHeaders = route.request().headers();
      await route.continue({
        headers: safeHeaderMerge(requestHeaders, headers),
      });
    };

    // Store and register the route
    this.scopedHeaderRoutes.set(urlPattern, handler);
    await page.route(urlPattern, handler);
  }

  /**
   * Clear scoped headers for an origin (or all if no origin specified)
   */
  async clearScopedHeaders(origin?: string): Promise<void> {
    const page = this.getPage();

    if (origin) {
      let urlPattern: string;
      try {
        const url = new URL(origin.startsWith('http') ? origin : `https://${origin}`);
        urlPattern = `**://${url.host}/**`;
      } catch {
        urlPattern = `**://${origin}/**`;
      }

      const handler = this.scopedHeaderRoutes.get(urlPattern);
      if (handler) {
        await page.unroute(urlPattern, handler);
        this.scopedHeaderRoutes.delete(urlPattern);
      }
    } else {
      // Clear all scoped header routes
      for (const [pattern, handler] of this.scopedHeaderRoutes) {
        await page.unroute(pattern, handler);
      }
      this.scopedHeaderRoutes.clear();
    }
  }

  /**
   * Start tracing
   */
  async startTracing(options: { screenshots?: boolean; snapshots?: boolean }): Promise<void> {
    const context = this.contexts[0];
    if (context) {
      await context.tracing.start({
        screenshots: options.screenshots ?? true,
        snapshots: options.snapshots ?? true,
      });
    }
  }

  /**
   * Stop tracing and save
   */
  async stopTracing(path?: string): Promise<void> {
    const context = this.contexts[0];
    if (context) {
      await context.tracing.stop(path ? { path } : undefined);
    }
  }

  /**
   * Get the current browser context (first context)
   */
  getContext(): BrowserContext | null {
    return this.contexts[0] ?? null;
  }

  /**
   * Save storage state (cookies, localStorage, etc.)
   */
  async saveStorageState(path: string): Promise<void> {
    const context = this.contexts[0];
    if (context) {
      await context.storageState({ path });
    }
  }

  /**
   * Get all pages
   */
  getPages(): Page[] {
    return this.pages;
  }

  /**
   * Get current page index
   */
  getActiveIndex(): number {
    return this.activePageIndex;
  }

  /**
   * Get the current browser instance
   */
  getBrowser(): Browser | null {
    return this.browser;
  }

  /**
   * Check if an existing CDP connection is still alive
   * by verifying we can access browser contexts and that at least one has pages
   */
  private isCdpConnectionAlive(): boolean {
    if (!this.browser) return false;
    try {
      const contexts = this.browser.contexts();
      if (contexts.length === 0) return false;
      return contexts.some((context) => context.pages().length > 0);
    } catch {
      return false;
    }
  }

  /**
   * Check if CDP connection needs to be re-established
   */
  private needsCdpReconnect(cdpEndpoint: string): boolean {
    if (!this.browser?.isConnected()) return true;
    if (this.cdpEndpoint !== cdpEndpoint) return true;
    if (!this.isCdpConnectionAlive()) return true;
    return false;
  }

  /**
   * Query running Scrapeless sessions and return the latest one
   */
  private async getLatestScrapelessSession(): Promise<string | null> {
    // First check cache
    const cachedSession = sessionCache.getLatestRunning();
    if (cachedSession) {
      logger.debug('Using cached session', { sessionId: cachedSession.sessionId });
      return cachedSession.sessionId;
    }

    // Cache miss - query API
    const apiClient = getApiClient();
    const latestSession = await apiClient.getLatestSession();

    if (latestSession) {
      // Cache the session
      sessionCache.set(latestSession, apiClient.getCdpUrl(latestSession.sessionId));
      return latestSession.sessionId;
    }

    return null;
  }

  /**
   * Connect to Scrapeless remote browser via CDP.
   * Requires SCRAPELESS_API_KEY environment variable.
   *
   * @param sessionId - Optional session ID to connect to. If not provided:
   *   1. Queries for running sessions and uses the latest one
   *   2. If no running sessions, creates a new session
   */
  private async connectToScrapeless(sessionId?: string): Promise<void> {
    const apiClient = getApiClient();
    let taskId: string;
    let cdpUrl: string;

    // If sessionId is provided, validate it first
    if (sessionId) {
      logger.debug('Validating provided session ID', { sessionId });

      // Check if the session still exists and is running
      try {
        const sessionList = await apiClient.listSessions();
        const session = sessionList.sessions.find((s: any) => s.sessionId === sessionId);

        if (!session) {
          throw new ScrapelessError(
            ScrapelessErrorType.SESSION_NOT_FOUND,
            `Session ${sessionId} not found in running sessions. It may have expired or been terminated. ` +
              `Use 'sessions' command to list active sessions or create a new session.`,
            { retryable: false }
          );
        }

        logger.debug('Session validation successful', { sessionId, status: session.status });
        taskId = sessionId;
        this.scrapelessSessionId = sessionId;
        cdpUrl = apiClient.getCdpUrl(sessionId);
        logger.logSessionEvent('connecting_to_existing', sessionId);
      } catch (error) {
        if (error instanceof ScrapelessError) {
          throw error;
        }
        throw new ScrapelessError(
          ScrapelessErrorType.API_ERROR,
          `Failed to validate session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          { retryable: false, cause: error as Error }
        );
      }
    } else {
      // Try to get the latest running session (with caching)
      const latestSessionId = await this.getLatestScrapelessSession();

      if (latestSessionId) {
        // Use existing session
        taskId = latestSessionId;
        this.scrapelessSessionId = latestSessionId;
        cdpUrl = apiClient.getCdpUrl(latestSessionId);
        logger.logSessionEvent('reusing_existing', latestSessionId);
      } else {
        // No running session, create a new one
        logger.info('No running sessions found, creating new session');

        const sessionParams: SessionCreateParams = {};

        // Optional session parameters
        const sessionTtl = getConfigValue('sessionTtl');
        if (sessionTtl) sessionParams.sessionTtl = sessionTtl;

        const sessionName = getConfigValue('sessionName');
        if (sessionName) sessionParams.sessionName = sessionName;

        const sessionRecording = getConfigValue('sessionRecording');
        if (sessionRecording) sessionParams.sessionRecording = sessionRecording;

        // Proxy configuration
        const proxyUrl = getConfigValue('proxyUrl');
        if (proxyUrl) {
          sessionParams.proxyUrl = proxyUrl;
        } else {
          const proxyCountry = getConfigValue('proxyCountry');
          if (proxyCountry) {
            sessionParams.proxyCountry = proxyCountry;

            // v2 API supports state and city
            if (apiClient.supportsFeature('proxy_state')) {
              const proxyState = getConfigValue('proxyState');
              if (proxyState) sessionParams.proxyState = proxyState;
            }

            if (apiClient.supportsFeature('proxy_city')) {
              const proxyCity = getConfigValue('proxyCity');
              if (proxyCity) sessionParams.proxyCity = proxyCity;
            }
          }
        }

        // Fingerprint configuration
        const fingerprint = getConfigValue('fingerprint');
        if (fingerprint) sessionParams.fingerprint = fingerprint;

        // Body parameters configuration
        const userAgent = getConfigValue('userAgent');
        if (userAgent) sessionParams.userAgent = userAgent;

        const platform = getConfigValue('platform');
        if (platform) sessionParams.platform = platform;

        const screenWidth = getConfigValue('screenWidth');
        if (screenWidth) sessionParams.screenWidth = parseInt(screenWidth, 10);

        const screenHeight = getConfigValue('screenHeight');
        if (screenHeight) sessionParams.screenHeight = parseInt(screenHeight, 10);

        const timezone = getConfigValue('timezone');
        if (timezone) sessionParams.timezone = timezone;

        const languages = getConfigValue('languages');
        if (languages) sessionParams.languages = languages.split(',').map((l) => l.trim());

        // Metadata configuration
        const metadataKeys = Object.keys(process.env).filter((key) =>
          key.startsWith('SCRAPELESS_METADATA_')
        );
        if (metadataKeys.length > 0) {
          sessionParams.metadata = {};
          metadataKeys.forEach((key) => {
            const metadataKey = key.replace('SCRAPELESS_METADATA_', '').toLowerCase();
            sessionParams.metadata![metadataKey] = process.env[key]!;
          });
        }

        const response = await apiClient.createSession(sessionParams);

        if (!response.success || !response.taskId) {
          const sessionError = new ScrapelessError(
            ScrapelessErrorType.API_ERROR,
            `Invalid Scrapeless session response: ${!response.success ? 'creation failed' : 'missing taskId'}`
          );
          logger.error('Invalid session creation response', sessionError);
          throw sessionError;
        }

        taskId = response.taskId;
        this.scrapelessSessionId = taskId;
        cdpUrl = apiClient.getCdpUrl(taskId);

        // Cache the new session
        sessionCache.set(
          {
            sessionId: taskId,
            createdAt: new Date().toISOString(),
            status: 'running',
            name: sessionParams.sessionName,
          },
          cdpUrl
        );

        logger.logSessionEvent('created_new', taskId);
      }
    }

    // Connect via WebSocket CDP
    logger.debug('Connecting to Scrapeless CDP', { sessionId: taskId });

    const browser = await withRetry(async () => {
      try {
        logger.debug('Attempting CDP connection', {
          url: cdpUrl.replace(/token=[^&]+/, 'token=[REDACTED]'),
        });
        return await chromium.connectOverCDP(cdpUrl);
      } catch (error) {
        logger.warn('CDP connection attempt failed', {
          error: error instanceof Error ? error.message : String(error),
          sessionId: taskId,
        });

        // Check if this is a "task completed" error (session terminated)
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes('task completed status') ||
          errorMessage.includes('400 Bad Request')
        ) {
          throw new ScrapelessError(
            ScrapelessErrorType.SESSION_TERMINATED,
            `Scrapeless session ${taskId} has been terminated and cannot be reconnected. ` +
              `Scrapeless sessions automatically terminate when the connection is closed. ` +
              `To use this session, you must maintain a persistent connection. ` +
              `Consider creating a new session instead.`,
            { retryable: false, cause: error as Error }
          );
        }

        throw new ScrapelessError(
          ScrapelessErrorType.NETWORK_ERROR,
          'Failed to connect to Scrapeless session via CDP',
          { retryable: true, cause: error as Error }
        );
      }
    });

    try {
      const contexts = browser.contexts();
      let context: BrowserContext;
      let page: Page;

      if (contexts.length === 0) {
        // This should not happen with Scrapeless sessions
        logger.error(
          'No existing contexts found in Scrapeless session - this indicates a connection problem'
        );
        throw new ScrapelessError(
          ScrapelessErrorType.CDP_ERROR,
          'No browser contexts found in Scrapeless session. The session may have expired or been terminated.'
        );
      } else {
        context = contexts[0];
        const pages = context.pages();
        logger.debug('Found existing Scrapeless context', {
          contexts: contexts.length,
          pages: pages.length,
          pageUrls: pages.map((p) => p.url()),
        });

        if (pages.length === 0) {
          // For Scrapeless sessions, this should not happen as sessions come with existing pages
          logger.error(
            'No existing pages found in Scrapeless session context - this indicates a connection problem'
          );
          throw new ScrapelessError(
            ScrapelessErrorType.CDP_ERROR,
            'No pages found in Scrapeless session context. The session may have expired or been terminated.'
          );
        } else {
          page = pages[0];
          logger.debug('Using existing page from Scrapeless session', {
            pageUrl: page.url(),
            isClosed: page.isClosed(),
          });

          // Check if the page is still valid
          if (page.isClosed()) {
            logger.warn(
              'Existing page is closed, attempting to use another page or create new one'
            );
            const validPages = pages.filter((p) => !p.isClosed());
            if (validPages.length > 0) {
              page = validPages[0];
              logger.debug('Using alternative valid page', { pageUrl: page.url() });
            } else {
              // All pages are closed in Scrapeless session - this indicates session expiry
              logger.error(
                'All existing pages are closed in Scrapeless session - session may have expired'
              );
              throw new ScrapelessError(
                ScrapelessErrorType.CDP_ERROR,
                'All pages in Scrapeless session are closed. The session may have expired or been terminated.'
              );
            }
          }
        }
      }

      this.browser = browser;
      context.setDefaultTimeout(getDefaultTimeout());

      // Only add context if not already tracked
      if (!this.contexts.includes(context)) {
        this.contexts.push(context);
        this.setupContextTracking(context);
        await this.ensureDomainFilter(context);
      }

      // Sanitize existing pages with better error handling
      try {
        await this.sanitizeExistingPages([page]);
      } catch (sanitizeError) {
        logger.warn('Failed to sanitize existing pages, continuing anyway', sanitizeError as Error);
      }

      // Only add page if not already tracked
      if (!this.pages.includes(page)) {
        this.pages.push(page);
        this.setupPageTracking(page);
      }
      this.activePageIndex = this.pages.indexOf(page);

      logger.logSessionEvent('connected', taskId, {
        contexts: contexts.length,
        pages: this.pages.length,
        activePageIndex: this.activePageIndex,
        activePageUrl: page.url(),
      });
    } catch (error) {
      // Clean up browser connection if setup failed
      try {
        await browser.close();
      } catch (closeError) {
        logger.warn('Failed to close browser after setup error', closeError as Error);
      }

      const connectionError = new ScrapelessError(
        ScrapelessErrorType.CDP_ERROR,
        `Failed to set up Scrapeless browser context: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error as Error }
      );
      logger.error('Failed to set up browser context', connectionError);
      throw connectionError;
    }
  }

  /**
   * Launch the browser with the specified options
   * Always connects to Scrapeless cloud browser
   * If already launched, this is a no-op (browser stays open)
   */
  async launch(options: LaunchCommand): Promise<void> {
    if (this.isLaunched()) {
      // Already connected, no need to reconnect
      return;
    }

    if (options.colorScheme) {
      this.colorScheme = options.colorScheme;
    }

    if (options.downloadPath) {
      this.downloadPath = options.downloadPath;
      const warning =
        "--download-path is ignored when using Scrapeless cloud browser (downloads use the remote browser's configuration)";
      this.launchWarnings.push(warning);
      console.error(`[WARN] ${warning}`);
    }

    if (options.allowedDomains && options.allowedDomains.length > 0) {
      this.allowedDomains = options.allowedDomains.map((d: string) => d.toLowerCase());
    } else {
      const envDomains = process.env.SCRAPELESS_BROWSER_ALLOWED_DOMAINS;
      if (envDomains) {
        this.allowedDomains = parseDomainList(envDomains);
      }
    }

    // Connect to Scrapeless cloud browser
    // Use sessionId from options if provided, otherwise auto-discover or create new session
    await this.connectToScrapeless(options.sessionId);
  }

  /**
   * Connect to a running browser via CDP (Chrome DevTools Protocol)
   * @param cdpEndpoint Either a port number (as string) or a full WebSocket URL (ws:// or wss://)
   */
  private async connectViaCDP(
    cdpEndpoint: string | undefined,
    options?: { timeout?: number }
  ): Promise<void> {
    if (!cdpEndpoint) {
      throw new Error('CDP endpoint is required for CDP connection');
    }

    // Determine the connection URL:
    // - If it starts with ws://, wss://, http://, or https://, use it directly
    // - If it's a numeric string (e.g., "9222"), treat as port for localhost
    // - Otherwise, treat it as a port number for localhost
    let cdpUrl: string;
    if (
      cdpEndpoint.startsWith('ws://') ||
      cdpEndpoint.startsWith('wss://') ||
      cdpEndpoint.startsWith('http://') ||
      cdpEndpoint.startsWith('https://')
    ) {
      cdpUrl = cdpEndpoint;
    } else if (/^\d+$/.test(cdpEndpoint)) {
      // Numeric string - treat as port number (handles JSON serialization quirks)
      cdpUrl = `http://localhost:${cdpEndpoint}`;
    } else {
      // Unknown format - still try as port for backward compatibility
      cdpUrl = `http://localhost:${cdpEndpoint}`;
    }

    const browser = await chromium
      .connectOverCDP(cdpUrl, { timeout: options?.timeout })
      .catch(() => {
        throw new Error(
          `Failed to connect via CDP to ${cdpUrl}. ` +
            (cdpUrl.includes('localhost')
              ? `Make sure the app is running with --remote-debugging-port=${cdpEndpoint}`
              : 'Make sure the remote browser is accessible and the URL is correct.')
        );
      });

    // Validate and set up state, cleaning up browser connection if anything fails
    try {
      const contexts = browser.contexts();
      if (contexts.length === 0) {
        throw new Error('No browser context found. Make sure the app has an open window.');
      }

      // Filter out pages with empty URLs, which can cause Playwright to hang
      const allPages = contexts.flatMap((context) => context.pages()).filter((page) => page.url());

      if (allPages.length === 0) {
        throw new Error('No page found. Make sure the app has loaded content.');
      }

      // All validation passed - commit state
      this.browser = browser;
      this.cdpEndpoint = cdpEndpoint;

      for (const context of contexts) {
        context.setDefaultTimeout(10000);
        this.contexts.push(context);
        this.setupContextTracking(context);
        await this.ensureDomainFilter(context);
      }

      await this.sanitizeExistingPages(allPages);

      for (const page of allPages) {
        this.pages.push(page);
        this.setupPageTracking(page);
      }

      this.activePageIndex = 0;
    } catch (error) {
      // Clean up browser connection if validation or setup failed
      await browser.close().catch(() => {});
      throw error;
    }
  }

  /**
   * Get Chrome's default user data directory paths for the current platform.
   * Returns an array of candidate paths to check (stable, then beta/canary).
   */
  private getChromeUserDataDirs(): string[] {
    const home = os.homedir();
    const platform = os.platform();

    if (platform === 'darwin') {
      return [
        path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
        path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Canary'),
        path.join(home, 'Library', 'Application Support', 'Chromium'),
      ];
    } else if (platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
      return [
        path.join(localAppData, 'Google', 'Chrome', 'User Data'),
        path.join(localAppData, 'Google', 'Chrome SxS', 'User Data'),
        path.join(localAppData, 'Chromium', 'User Data'),
      ];
    } else {
      // Linux
      return [
        path.join(home, '.config', 'google-chrome'),
        path.join(home, '.config', 'google-chrome-unstable'),
        path.join(home, '.config', 'chromium'),
      ];
    }
  }

  /**
   * Try to read the DevToolsActivePort file from a Chrome user data directory.
   * Returns { port, wsPath } if found, or null if not available.
   */
  private readDevToolsActivePort(userDataDir: string): { port: number; wsPath: string } | null {
    const filePath = path.join(userDataDir, 'DevToolsActivePort');
    try {
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath, 'utf-8').trim();
      const lines = content.split('\n');
      if (lines.length < 2) return null;

      const port = parseInt(lines[0].trim(), 10);
      const wsPath = lines[1].trim();

      if (isNaN(port) || port <= 0 || port > 65535) return null;
      if (!wsPath) return null;

      return { port, wsPath };
    } catch {
      return null;
    }
  }

  /**
   * Try to discover a Chrome CDP endpoint by querying an HTTP debug port.
   * Returns the WebSocket debugger URL if available.
   */
  private async probeDebugPort(port: number): Promise<string | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { webSocketDebuggerUrl?: string };
      return data.webSocketDebuggerUrl ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Auto-discover and connect to a running Chrome/Chromium instance.
   *
   * Discovery strategy:
   * 1. Read DevToolsActivePort from Chrome's default user data directories
   * 2. If found, connect using the port and WebSocket path from that file
   * 3. If not found, probe common debugging ports (9222, 9229)
   * 4. If a port responds, connect via CDP
   */
  private async autoConnectViaCDP(): Promise<void> {
    // Strategy 1: Check DevToolsActivePort files
    const userDataDirs = this.getChromeUserDataDirs();
    for (const dir of userDataDirs) {
      const activePort = this.readDevToolsActivePort(dir);
      if (activePort) {
        // Try HTTP discovery first (works with --remote-debugging-port mode)
        const wsUrl = await this.probeDebugPort(activePort.port);
        if (wsUrl) {
          await this.connectViaCDP(wsUrl);
          return;
        }
        // HTTP probe failed -- Chrome M144+ chrome://inspect remote debugging uses a
        // WebSocket-only server with no HTTP endpoints. Connect using the WebSocket
        // path read directly from DevToolsActivePort.
        const directWsUrl = `ws://127.0.0.1:${activePort.port}${activePort.wsPath}`;
        try {
          if (process.env.SCRAPELESS_BROWSER_DEBUG === '1') {
            console.error(
              `[DEBUG] HTTP probe failed on port ${activePort.port}, ` +
                `attempting direct WebSocket connection to ${directWsUrl}`
            );
          }
          await this.connectViaCDP(directWsUrl, { timeout: 60_000 });
          return;
        } catch {
          // Direct WebSocket also failed, try next directory
        }
      }
    }

    // Strategy 2: Probe common debugging ports
    const commonPorts = [9222, 9229];
    for (const port of commonPorts) {
      const wsUrl = await this.probeDebugPort(port);
      if (wsUrl) {
        await this.connectViaCDP(wsUrl);
        return;
      }
    }

    // Nothing found
    const platform = os.platform();
    let hint: string;
    if (platform === 'darwin') {
      hint =
        'Start Chrome with: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n' +
        'Or enable remote debugging in Chrome 144+ at chrome://inspect/#remote-debugging';
    } else if (platform === 'win32') {
      hint =
        'Start Chrome with: chrome.exe --remote-debugging-port=9222\n' +
        'Or enable remote debugging in Chrome 144+ at chrome://inspect/#remote-debugging';
    } else {
      hint =
        'Start Chrome with: google-chrome --remote-debugging-port=9222\n' +
        'Or enable remote debugging in Chrome 144+ at chrome://inspect/#remote-debugging';
    }

    throw new Error(`No running Chrome instance with remote debugging found.\n${hint}`);
  }

  /**
   * Set up console, error, and close tracking for a page
   */
  private setupPageTracking(page: Page): void {
    // Skip setup if page is already closed
    if (page.isClosed()) {
      logger.warn('Attempted to setup tracking for already closed page');
      return;
    }

    if (this.colorScheme) {
      page.emulateMedia({ colorScheme: this.colorScheme }).catch(() => {});
    }

    page.on('console', (msg) => {
      this.consoleMessages.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
    });

    page.on('pageerror', (error) => {
      this.pageErrors.push({
        message: error.message,
        timestamp: Date.now(),
      });
    });

    page.on('close', () => {
      logger.debug('Page closed event received', {
        pageUrl: page.url(),
        isScrapeless: !!this.scrapelessSessionId,
      });

      const index = this.pages.indexOf(page);
      if (index !== -1) {
        this.pages.splice(index, 1);
        if (this.activePageIndex >= this.pages.length) {
          this.activePageIndex = Math.max(0, this.pages.length - 1);
        }

        logger.debug('Updated page tracking after close', {
          remainingPages: this.pages.length,
          activePageIndex: this.activePageIndex,
        });
      }
    });
  }

  /**
   * Set up tracking for new pages in a context (for CDP connections and popups/new tabs)
   * This handles pages created externally (e.g., via target="_blank" links, window.open)
   */
  private setupContextTracking(context: BrowserContext): void {
    context.on('page', (page) => {
      // Only add if not already tracked (avoids duplicates when newTab() creates pages)
      if (!this.pages.includes(page)) {
        this.pages.push(page);
        this.setupPageTracking(page);
      }

      // Auto-switch to the newly opened tab so subsequent commands target it.
      // For tabs created via newTab()/newWindow(), this is redundant (they set activePageIndex after),
      // but for externally opened tabs (window.open, target="_blank"), this ensures the active tab
      // stays in sync with the browser.
      const newIndex = this.pages.indexOf(page);
      if (newIndex !== -1 && newIndex !== this.activePageIndex) {
        this.activePageIndex = newIndex;
        // Invalidate CDP session since the active page changed
        this.invalidateCDPSession().catch(() => {});
      }
    });
  }

  /**
   * Create a new tab in the current context
   * For Scrapeless sessions, uses existing pages instead of creating new ones
   */
  async newTab(): Promise<{ index: number; total: number }> {
    if (!this.browser || this.contexts.length === 0) {
      throw new Error('Browser not launched');
    }

    // Invalidate CDP session since we're switching to a new page
    await this.invalidateCDPSession();

    // For Scrapeless sessions, don't create new pages - use existing ones
    if (this.scrapelessSessionId) {
      logger.debug('NewTab requested for Scrapeless session - using existing pages', {
        sessionId: this.scrapelessSessionId,
        existingPages: this.pages.length,
      });

      // If we have multiple pages, switch to the next one
      if (this.pages.length > 1) {
        this.activePageIndex = (this.activePageIndex + 1) % this.pages.length;
        logger.debug('Switched to existing page', {
          activePageIndex: this.activePageIndex,
          pageUrl: this.pages[this.activePageIndex].url(),
        });
      } else {
        // Only one page available, stay on it
        logger.debug('Only one page available in Scrapeless session, staying on current page');
      }

      return { index: this.activePageIndex, total: this.pages.length };
    }

    // For regular browser sessions, create new page as usual
    const context = this.contexts[0]; // Use first context for tabs
    const page = await context.newPage();
    // Only add if not already tracked (setupContextTracking may have already added it via 'page' event)
    if (!this.pages.includes(page)) {
      this.pages.push(page);
      this.setupPageTracking(page);
    }
    this.activePageIndex = this.pages.length - 1;

    return { index: this.activePageIndex, total: this.pages.length };
  }

  /**
   * Create a new window (new context)
   * For Scrapeless sessions, uses existing pages instead of creating new contexts
   */
  async newWindow(viewport?: { width: number; height: number } | null): Promise<{
    index: number;
    total: number;
  }> {
    if (!this.browser) {
      throw new Error('Browser not launched');
    }

    // For Scrapeless sessions, don't create new contexts - use existing pages
    if (this.scrapelessSessionId) {
      logger.debug('NewWindow requested for Scrapeless session - using existing pages', {
        sessionId: this.scrapelessSessionId,
        existingPages: this.pages.length,
      });

      // If we have multiple pages, switch to the next one
      if (this.pages.length > 1) {
        this.activePageIndex = (this.activePageIndex + 1) % this.pages.length;
        logger.debug('Switched to existing page for new window', {
          activePageIndex: this.activePageIndex,
          pageUrl: this.pages[this.activePageIndex].url(),
        });
      } else {
        // Only one page available, stay on it
        logger.debug(
          'Only one page available in Scrapeless session for new window, staying on current page'
        );
      }

      return { index: this.activePageIndex, total: this.pages.length };
    }

    // For regular browser sessions, create new context as usual
    const context = await this.browser.newContext({
      viewport: viewport === undefined ? { width: 1280, height: 720 } : viewport,
      ...(this.colorScheme && { colorScheme: this.colorScheme }),
    });
    context.setDefaultTimeout(getDefaultTimeout());
    this.contexts.push(context);
    this.setupContextTracking(context);
    await this.ensureDomainFilter(context);

    const page = await context.newPage();
    // Only add if not already tracked (setupContextTracking may have already added it via 'page' event)
    if (!this.pages.includes(page)) {
      this.pages.push(page);
      this.setupPageTracking(page);
    }
    this.activePageIndex = this.pages.length - 1;

    return { index: this.activePageIndex, total: this.pages.length };
  }

  /**
   * Invalidate the current CDP session (must be called before switching pages)
   * This ensures screencast and input injection work correctly after tab switch
   */
  private async invalidateCDPSession(): Promise<void> {
    // Stop screencast if active (it's tied to the current page's CDP session)
    if (this.screencastActive) {
      await this.stopScreencast();
    }

    // Detach and clear the CDP session
    if (this.cdpSession) {
      await this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    }
  }

  /**
   * Switch to a specific tab/page by index
   */
  async switchTo(index: number): Promise<{ index: number; url: string; title: string }> {
    if (index < 0 || index >= this.pages.length) {
      throw new Error(`Invalid tab index: ${index}. Available: 0-${this.pages.length - 1}`);
    }

    // Invalidate CDP session before switching (it's page-specific)
    if (index !== this.activePageIndex) {
      await this.invalidateCDPSession();
    }

    this.activePageIndex = index;
    const page = this.pages[index];

    return {
      index: this.activePageIndex,
      url: page.url(),
      title: '', // Title requires async, will be fetched separately
    };
  }

  /**
   * Close a specific tab/page
   */
  async closeTab(index?: number): Promise<{ closed: number; remaining: number }> {
    const targetIndex = index ?? this.activePageIndex;

    if (targetIndex < 0 || targetIndex >= this.pages.length) {
      throw new Error(`Invalid tab index: ${targetIndex}`);
    }

    if (this.pages.length === 1) {
      throw new Error('Cannot close the last tab. Use "close" to close the browser.');
    }

    // If closing the active tab, invalidate CDP session first
    if (targetIndex === this.activePageIndex) {
      await this.invalidateCDPSession();
    }

    const page = this.pages[targetIndex];
    await page.close();
    this.pages.splice(targetIndex, 1);

    // Adjust active index if needed
    if (this.activePageIndex >= this.pages.length) {
      this.activePageIndex = this.pages.length - 1;
    } else if (this.activePageIndex > targetIndex) {
      this.activePageIndex--;
    }

    return { closed: targetIndex, remaining: this.pages.length };
  }

  /**
   * List all tabs with their info
   */
  async listTabs(): Promise<Array<{ index: number; url: string; title: string; active: boolean }>> {
    const tabs = await Promise.all(
      this.pages.map(async (page, index) => ({
        index,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: index === this.activePageIndex,
      }))
    );
    return tabs;
  }

  /**
   * Get or create a CDP session for the current page
   * Only works with Chromium-based browsers
   */
  async getCDPSession(): Promise<CDPSession> {
    if (this.cdpSession) {
      return this.cdpSession;
    }

    const page = this.getPage();
    const context = page.context();

    // Create a new CDP session attached to the page
    this.cdpSession = await context.newCDPSession(page);
    return this.cdpSession;
  }

  /**
   * Check if screencast is currently active
   */
  isScreencasting(): boolean {
    return this.screencastActive;
  }

  /**
   * Start screencast - streams viewport frames via CDP
   * @param callback Function called for each frame
   * @param options Screencast options
   */
  async startScreencast(
    callback: (frame: ScreencastFrame) => void,
    options?: ScreencastOptions
  ): Promise<void> {
    if (this.screencastActive) {
      throw new Error('Screencast already active');
    }

    const cdp = await this.getCDPSession();
    this.frameCallback = callback;
    this.screencastActive = true;

    // Create and store the frame handler so we can remove it later
    this.screencastFrameHandler = async (params: any) => {
      const frame: ScreencastFrame = {
        data: params.data,
        metadata: params.metadata,
        sessionId: params.sessionId,
      };

      // Acknowledge the frame to receive the next one
      await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId });

      // Call the callback with the frame
      if (this.frameCallback) {
        this.frameCallback(frame);
      }
    };

    // Listen for screencast frames
    cdp.on('Page.screencastFrame', this.screencastFrameHandler);

    // Start the screencast
    await cdp.send('Page.startScreencast', {
      format: options?.format ?? 'jpeg',
      quality: options?.quality ?? 80,
      maxWidth: options?.maxWidth ?? 1280,
      maxHeight: options?.maxHeight ?? 720,
      everyNthFrame: options?.everyNthFrame ?? 1,
    });
  }

  /**
   * Stop screencast
   */
  async stopScreencast(): Promise<void> {
    if (!this.screencastActive) {
      return;
    }

    try {
      const cdp = await this.getCDPSession();
      await cdp.send('Page.stopScreencast');

      // Remove the event listener to prevent accumulation
      if (this.screencastFrameHandler) {
        cdp.off('Page.screencastFrame', this.screencastFrameHandler);
      }
    } catch {
      // Ignore errors when stopping
    }

    this.screencastActive = false;
    this.frameCallback = null;
    this.screencastFrameHandler = null;
  }

  /**
   * Check if profiling is currently active
   */
  isProfilingActive(): boolean {
    return this.profilingActive;
  }

  /**
   * Start CDP profiling (Tracing)
   */
  async startProfiling(options?: { categories?: string[] }): Promise<void> {
    if (this.profilingActive) {
      throw new Error('Profiling already active');
    }

    const cdp = await this.getCDPSession();

    const dataHandler = (params: { value?: TraceEvent[] }) => {
      if (params.value) {
        for (const evt of params.value) {
          if (this.profileChunks.length >= BrowserManager.MAX_PROFILE_EVENTS) {
            if (!this.profileEventsDropped) {
              this.profileEventsDropped = true;
              console.warn(
                `Profiling: exceeded ${BrowserManager.MAX_PROFILE_EVENTS} events, dropping further data`
              );
            }
            return;
          }
          this.profileChunks.push(evt);
        }
      }
    };

    const completeHandler = () => {
      if (this.profileCompleteResolver) {
        this.profileCompleteResolver();
      }
    };

    cdp.on('Tracing.dataCollected', dataHandler);
    cdp.on('Tracing.tracingComplete', completeHandler);

    const categories = options?.categories ?? [
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'disabled-by-default-devtools.timeline.stack',
      'v8.execute',
      'disabled-by-default-v8.cpu_profiler',
      'disabled-by-default-v8.cpu_profiler.hires',
      'v8',
      'disabled-by-default-v8.runtime_stats',
      'blink',
      'blink.user_timing',
      'latencyInfo',
      'renderer.scheduler',
      'sequence_manager',
      'toplevel',
    ];

    try {
      await cdp.send('Tracing.start', {
        traceConfig: {
          includedCategories: categories,
          enableSampling: true,
        },
        transferMode: 'ReportEvents',
      });
    } catch (error) {
      cdp.off('Tracing.dataCollected', dataHandler);
      cdp.off('Tracing.tracingComplete', completeHandler);
      throw error;
    }

    // Only commit state after the CDP call succeeds
    this.profilingActive = true;
    this.profileChunks = [];
    this.profileEventsDropped = false;
    this.profileDataHandler = dataHandler;
    this.profileCompleteHandler = completeHandler;
  }

  /**
   * Stop CDP profiling and save to file
   */
  async stopProfiling(outputPath: string): Promise<{ path: string; eventCount: number }> {
    if (!this.profilingActive) {
      throw new Error('No profiling session active');
    }

    const cdp = await this.getCDPSession();

    const TRACE_TIMEOUT_MS = 30_000;
    const completePromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Profiling data collection timed out')),
        TRACE_TIMEOUT_MS
      );
      this.profileCompleteResolver = () => {
        clearTimeout(timer);
        resolve();
      };
    });

    await cdp.send('Tracing.end');

    let chunks: TraceEvent[];
    try {
      await completePromise;
      chunks = this.profileChunks;
    } finally {
      if (this.profileDataHandler) {
        cdp.off('Tracing.dataCollected', this.profileDataHandler);
      }
      if (this.profileCompleteHandler) {
        cdp.off('Tracing.tracingComplete', this.profileCompleteHandler);
      }
      this.profilingActive = false;
      this.profileChunks = [];
      this.profileEventsDropped = false;
      this.profileCompleteResolver = null;
      this.profileDataHandler = null;
      this.profileCompleteHandler = null;
    }

    const clockDomain =
      process.platform === 'linux'
        ? 'LINUX_CLOCK_MONOTONIC'
        : process.platform === 'darwin'
          ? 'MAC_MACH_ABSOLUTE_TIME'
          : undefined;

    const traceData: Record<string, unknown> = {
      traceEvents: chunks,
    };
    if (clockDomain) {
      traceData.metadata = { 'clock-domain': clockDomain };
    }

    const dir = path.dirname(outputPath);
    await mkdir(dir, { recursive: true });

    await writeFile(outputPath, JSON.stringify(traceData));

    const eventCount = chunks.length;

    return { path: outputPath, eventCount };
  }

  /**
   * Inject a mouse event via CDP
   */
  async injectMouseEvent(params: {
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
    x: number;
    y: number;
    button?: 'left' | 'right' | 'middle' | 'none';
    clickCount?: number;
    deltaX?: number;
    deltaY?: number;
    modifiers?: number; // 1=Alt, 2=Ctrl, 4=Meta, 8=Shift
  }): Promise<void> {
    const cdp = await this.getCDPSession();

    const cdpButton =
      params.button === 'left'
        ? 'left'
        : params.button === 'right'
          ? 'right'
          : params.button === 'middle'
            ? 'middle'
            : 'none';

    await cdp.send('Input.dispatchMouseEvent', {
      type: params.type,
      x: params.x,
      y: params.y,
      button: cdpButton,
      clickCount: params.clickCount ?? 1,
      deltaX: params.deltaX ?? 0,
      deltaY: params.deltaY ?? 0,
      modifiers: params.modifiers ?? 0,
    });
  }

  /**
   * Inject a keyboard event via CDP
   */
  async injectKeyboardEvent(params: {
    type: 'keyDown' | 'keyUp' | 'char';
    key?: string;
    code?: string;
    text?: string;
    modifiers?: number; // 1=Alt, 2=Ctrl, 4=Meta, 8=Shift
  }): Promise<void> {
    const cdp = await this.getCDPSession();

    await cdp.send('Input.dispatchKeyEvent', {
      type: params.type,
      key: params.key,
      code: params.code,
      text: params.text,
      modifiers: params.modifiers ?? 0,
    });
  }

  /**
   * Inject touch event via CDP (for mobile emulation)
   */
  async injectTouchEvent(params: {
    type: 'touchStart' | 'touchEnd' | 'touchMove' | 'touchCancel';
    touchPoints: Array<{ x: number; y: number; id?: number }>;
    modifiers?: number;
  }): Promise<void> {
    const cdp = await this.getCDPSession();

    await cdp.send('Input.dispatchTouchEvent', {
      type: params.type,
      touchPoints: params.touchPoints.map((tp, i) => ({
        x: tp.x,
        y: tp.y,
        id: tp.id ?? i,
      })),
      modifiers: params.modifiers ?? 0,
    });
  }

  /**
   * Check if video recording is currently active
   */
  isRecording(): boolean {
    return this.recordingContext !== null;
  }

  /**
   * Start recording to a video file using Playwright's native video recording.
   * Creates a fresh browser context with video recording enabled.
   * Automatically captures current URL and transfers cookies/storage if no URL provided.
   *
   * @param outputPath - Path to the output video file (will be .webm)
   * @param url - Optional URL to navigate to (defaults to current page URL)
   */
  async startRecording(outputPath: string, url?: string): Promise<void> {
    if (this.recordingContext) {
      throw new Error(
        "Recording already in progress. Run 'record stop' first, or use 'record restart' to stop and start a new recording."
      );
    }

    if (!this.browser) {
      throw new Error('Browser not launched. Call launch first.');
    }

    // Check if output file already exists
    if (existsSync(outputPath)) {
      throw new Error(`Output file already exists: ${outputPath}`);
    }

    // Validate output path is .webm (Playwright native format)
    if (!outputPath.endsWith('.webm')) {
      throw new Error(
        'Playwright native recording only supports WebM format. Please use a .webm extension.'
      );
    }

    // Auto-capture current URL if none provided
    const currentPage = this.pages.length > 0 ? this.pages[this.activePageIndex] : null;
    const currentContext = this.contexts.length > 0 ? this.contexts[0] : null;
    if (!url && currentPage) {
      const currentUrl = currentPage.url();
      if (currentUrl && currentUrl !== 'about:blank') {
        url = currentUrl;
      }
    }

    // Capture state from current context (cookies + storage)
    let storageState:
      | {
          cookies: Array<{
            name: string;
            value: string;
            domain: string;
            path: string;
            expires: number;
            httpOnly: boolean;
            secure: boolean;
            sameSite: 'Strict' | 'Lax' | 'None';
          }>;
          origins: Array<{
            origin: string;
            localStorage: Array<{ name: string; value: string }>;
          }>;
        }
      | undefined;

    if (currentContext) {
      try {
        storageState = await currentContext.storageState();
      } catch {
        // Ignore errors - context might be closed or invalid
      }
    }

    // Create a temp directory for video recording
    const session = process.env.SCRAPELESS_BROWSER_SESSION || 'default';
    this.recordingTempDir = path.join(
      os.tmpdir(),
      `agent-browser-recording-${session}-${Date.now()}`
    );
    mkdirSync(this.recordingTempDir, { recursive: true });

    this.recordingOutputPath = outputPath;

    // Reuse the active page viewport when available so recording matches the current layout.
    const viewport = currentPage?.viewportSize() ?? { width: 1280, height: 720 };
    this.recordingContext = await this.browser.newContext({
      viewport,
      recordVideo: {
        dir: this.recordingTempDir,
        size: viewport,
      },
      storageState,
    });
    this.recordingContext.setDefaultTimeout(10000);

    // Create a page in the recording context
    this.recordingPage = await this.recordingContext.newPage();

    // Add the recording context and page to our managed lists
    this.contexts.push(this.recordingContext);
    this.pages.push(this.recordingPage);
    this.activePageIndex = this.pages.length - 1;

    // Set up page tracking
    this.setupPageTracking(this.recordingPage);

    // Invalidate CDP session since we switched pages
    await this.invalidateCDPSession();

    // Navigate to URL if provided or captured
    if (url) {
      await this.recordingPage.goto(url, { waitUntil: 'load' });
    }
  }

  /**
   * Stop recording and save the video file
   * @returns Recording result with path
   */
  async stopRecording(): Promise<{ path: string; frames: number; error?: string }> {
    if (!this.recordingContext || !this.recordingPage) {
      return { path: '', frames: 0, error: 'No recording in progress' };
    }

    const outputPath = this.recordingOutputPath;

    try {
      // Get the video object before closing the page
      const video = this.recordingPage.video();

      // Remove recording page/context from our managed lists before closing
      const pageIndex = this.pages.indexOf(this.recordingPage);
      if (pageIndex !== -1) {
        this.pages.splice(pageIndex, 1);
      }
      const contextIndex = this.contexts.indexOf(this.recordingContext);
      if (contextIndex !== -1) {
        this.contexts.splice(contextIndex, 1);
      }

      // Close the page to finalize the video
      await this.recordingPage.close();

      // Save the video to the desired output path
      if (video) {
        await video.saveAs(outputPath);
      }

      // Clean up temp directory
      if (this.recordingTempDir) {
        rmSync(this.recordingTempDir, { recursive: true, force: true });
      }

      // Close the recording context
      await this.recordingContext.close();

      // Reset recording state
      this.recordingContext = null;
      this.recordingPage = null;
      this.recordingOutputPath = '';
      this.recordingTempDir = '';

      // Adjust active page index
      if (this.pages.length > 0) {
        this.activePageIndex = Math.min(this.activePageIndex, this.pages.length - 1);
      } else {
        this.activePageIndex = 0;
      }

      // Invalidate CDP session since we may have switched pages
      await this.invalidateCDPSession();

      return { path: outputPath, frames: 0 }; // Playwright doesn't expose frame count
    } catch (error) {
      // Clean up temp directory on error
      if (this.recordingTempDir) {
        rmSync(this.recordingTempDir, { recursive: true, force: true });
      }

      // Reset state on error
      this.recordingContext = null;
      this.recordingPage = null;
      this.recordingOutputPath = '';
      this.recordingTempDir = '';

      const message = error instanceof Error ? error.message : String(error);
      return { path: outputPath, frames: 0, error: message };
    }
  }

  /**
   * Restart recording - stops current recording (if any) and starts a new one.
   * Convenience method that combines stopRecording and startRecording.
   *
   * @param outputPath - Path to the output video file (must be .webm)
   * @param url - Optional URL to navigate to (defaults to current page URL)
   * @returns Result from stopping the previous recording (if any)
   */
  async restartRecording(
    outputPath: string,
    url?: string
  ): Promise<{ previousPath?: string; stopped: boolean }> {
    let previousPath: string | undefined;
    let stopped = false;

    // Stop current recording if active
    if (this.recordingContext) {
      const result = await this.stopRecording();
      previousPath = result.path;
      stopped = true;
    }

    // Start new recording
    await this.startRecording(outputPath, url);

    return { previousPath, stopped };
  }

  /**
   * Close the browser and clean up
   */
  async close(): Promise<void> {
    // Stop recording if active (saves video)
    if (this.recordingContext) {
      await this.stopRecording();
    }

    // Stop screencast if active
    if (this.screencastActive) {
      await this.stopScreencast();
    }

    // Clean up profiling state if active (without saving)
    if (this.profilingActive) {
      const cdp = this.cdpSession;
      if (cdp) {
        if (this.profileDataHandler) {
          cdp.off('Tracing.dataCollected', this.profileDataHandler);
        }
        if (this.profileCompleteHandler) {
          cdp.off('Tracing.tracingComplete', this.profileCompleteHandler);
        }
        await cdp.send('Tracing.end').catch(() => {});
      }
      this.profilingActive = false;
      this.profileChunks = [];
      this.profileEventsDropped = false;
      this.profileCompleteResolver = null;
      this.profileDataHandler = null;
      this.profileCompleteHandler = null;
    }

    // Clean up CDP session
    if (this.cdpSession) {
      await this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    }

    // Scrapeless sessions auto-close on disconnect, no explicit cleanup needed
    if (this.cdpEndpoint !== null) {
      // CDP: only disconnect, don't close external app's pages
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }
    } else {
      // Regular browser: close everything
      for (const page of this.pages) {
        await page.close().catch(() => {});
      }
      for (const context of this.contexts) {
        await context.close().catch(() => {});
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }
    }

    this.pages = [];
    this.contexts = [];
    this.cdpEndpoint = null;
    this.isPersistentContext = false;
    this.activePageIndex = 0;
    this.colorScheme = null;
    this.refMap = {};
    this.lastSnapshot = '';
    this.frameCallback = null;
  }
}
