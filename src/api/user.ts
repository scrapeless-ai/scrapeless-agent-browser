/**
 * Scrapeless User API
 * Handles user account information
 */

import { ScrapelessClient } from './client.js';
import { UserInfo } from './types.js';

export class ScrapelessUserAPI {
  constructor(private client: ScrapelessClient) {}

  /**
   * Get user account information
   * Based on: GET /user/info
   */
  async getUserInfo(): Promise<UserInfo> {
    return this.client.request<UserInfo>('GET', '/user/info');
  }

  /**
   * Get user credits balance
   */
  async getCredits(): Promise<number> {
    const userInfo = await this.getUserInfo();
    return parseFloat(userInfo.credits);
  }

  /**
   * Check if user has sufficient credits
   */
  async hasCredits(minimumCredits: number = 0.1): Promise<boolean> {
    const credits = await this.getCredits();
    return credits >= minimumCredits;
  }
}
