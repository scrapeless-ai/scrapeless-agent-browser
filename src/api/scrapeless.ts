/**
 * Main Scrapeless API class
 * Provides a unified interface to all Scrapeless services
 */

import { ScrapelessClient, ClientOptions } from './client.js';
import { ScrapelessBrowserAPI } from './browser.js';
import { ScrapelessUserAPI } from './user.js';

export class ScrapelessAPI {
  private client: ScrapelessClient;

  public readonly browser: ScrapelessBrowserAPI;
  public readonly user: ScrapelessUserAPI;

  constructor(options: ClientOptions = {}) {
    this.client = new ScrapelessClient(options);
    this.browser = new ScrapelessBrowserAPI(this.client);
    this.user = new ScrapelessUserAPI(this.client);
  }

  /**
   * Get the underlying client for advanced usage
   */
  getClient(): ScrapelessClient {
    return this.client;
  }

  /**
   * Test API connectivity
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.user.getUserInfo();
      return true;
    } catch {
      return false;
    }
  }
}
