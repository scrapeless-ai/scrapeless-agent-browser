/**
 * Error handling for Scrapeless API
 */

export class ScrapelessAPIError extends Error {
  public readonly code: number;
  public readonly response?: any;

  constructor(message: string, code: number = 500, response?: any) {
    super(message);
    this.name = 'ScrapelessAPIError';
    this.code = code;
    this.response = response;
  }

  static fromResponse(response: Response, body?: any): ScrapelessAPIError {
    const message = body?.message || `HTTP ${response.status}: ${response.statusText}`;
    return new ScrapelessAPIError(message, response.status, body);
  }

  static fromScrapelessResponse(response: {
    code: number;
    message: string;
    data?: any;
  }): ScrapelessAPIError {
    return new ScrapelessAPIError(response.message, response.code, response);
  }
}

export class ScrapelessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScrapelessConfigError';
  }
}
