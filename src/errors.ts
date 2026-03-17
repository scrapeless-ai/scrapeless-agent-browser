/**
 * Error types and classes for Scrapeless Browser Skills
 */

export enum ScrapelessErrorType {
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_TERMINATED = 'SESSION_TERMINATED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  INVALID_CONFIGURATION = 'INVALID_CONFIGURATION',
  CDP_ERROR = 'CDP_ERROR',
  ELEMENT_NOT_FOUND = 'ELEMENT_NOT_FOUND',
  INVALID_SELECTOR = 'INVALID_SELECTOR',
  API_ERROR = 'API_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export class ScrapelessError extends Error {
  public readonly type: ScrapelessErrorType;
  public readonly code?: string;
  public readonly statusCode?: number;
  public readonly retryable: boolean;

  constructor(
    type: ScrapelessErrorType,
    message: string,
    options: {
      code?: string;
      statusCode?: number;
      retryable?: boolean;
      cause?: Error;
    } = {}
  ) {
    super(message);
    this.name = 'ScrapelessError';
    this.type = type;
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;

    if (options.cause) {
      this.cause = options.cause;
    }
  }

  static fromResponse(response: Response, body?: any): ScrapelessError {
    const statusCode = response.status;
    let type: ScrapelessErrorType;
    let message: string;
    let retryable = false;

    switch (statusCode) {
      case 401:
      case 403:
        type = ScrapelessErrorType.AUTHENTICATION_ERROR;
        message = 'Authentication failed. Please check your API key.';
        break;
      case 404:
        type = ScrapelessErrorType.SESSION_NOT_FOUND;
        message = 'Session not found. It may have expired or been terminated.';
        break;
      case 408:
      case 504:
        type = ScrapelessErrorType.TIMEOUT_ERROR;
        message = 'Request timed out. Please try again.';
        retryable = true;
        break;
      case 429:
        type = ScrapelessErrorType.API_ERROR;
        message = 'Rate limit exceeded. Please wait before retrying.';
        retryable = true;
        break;
      case 500:
      case 502:
      case 503:
        type = ScrapelessErrorType.API_ERROR;
        message = 'Server error. Please try again later.';
        retryable = true;
        break;
      default:
        type = ScrapelessErrorType.API_ERROR;
        message = body?.error || `HTTP ${statusCode}: ${response.statusText}`;
    }

    return new ScrapelessError(type, message, {
      statusCode,
      retryable,
      code: body?.code,
    });
  }

  static fromNetworkError(error: Error): ScrapelessError {
    return new ScrapelessError(
      ScrapelessErrorType.NETWORK_ERROR,
      `Network error: ${error.message}`,
      {
        retryable: true,
        cause: error,
      }
    );
  }

  static fromCDPError(error: any): ScrapelessError {
    return new ScrapelessError(
      ScrapelessErrorType.CDP_ERROR,
      `CDP error: ${error.message || 'Unknown CDP error'}`,
      {
        code: error.code?.toString(),
        cause: error,
      }
    );
  }

  static elementNotFound(selector: string): ScrapelessError {
    return new ScrapelessError(
      ScrapelessErrorType.ELEMENT_NOT_FOUND,
      `Element not found: ${selector}. Make sure the element exists and is visible.`,
      {
        code: 'ELEMENT_NOT_FOUND',
      }
    );
  }

  static invalidSelector(selector: string): ScrapelessError {
    return new ScrapelessError(
      ScrapelessErrorType.INVALID_SELECTOR,
      `Invalid selector: ${selector}. Please check the selector syntax.`,
      {
        code: 'INVALID_SELECTOR',
      }
    );
  }

  static invalidConfiguration(message: string): ScrapelessError {
    return new ScrapelessError(
      ScrapelessErrorType.INVALID_CONFIGURATION,
      `Configuration error: ${message}`,
      {
        code: 'INVALID_CONFIGURATION',
      }
    );
  }

  /**
   * Get a user-friendly error message with helpful suggestions
   */
  getUserMessage(): string {
    switch (this.type) {
      case ScrapelessErrorType.AUTHENTICATION_ERROR:
        return `${this.message}\n\nSuggestions:\n- Check your API key with: scrapeless-scraping-browser config get key\n- Set your API key with: scrapeless-scraping-browser config set key YOUR_API_KEY\n- Verify your API key is valid at https://scrapeless.com/dashboard`;

      case ScrapelessErrorType.SESSION_NOT_FOUND:
        return `${this.message}\n\nSuggestions:\n- List active sessions: scrapeless-scraping-browser sessions\n- Create a new session by running any browser command\n- Check if your session has expired`;

      case ScrapelessErrorType.NETWORK_ERROR:
        return `${this.message}\n\nSuggestions:\n- Check your internet connection\n- Verify Scrapeless API is accessible\n- Try again in a few moments`;

      case ScrapelessErrorType.TIMEOUT_ERROR:
        return `${this.message}\n\nSuggestions:\n- Try again with a longer timeout\n- Check if the target website is responsive\n- Use --debug flag for more details`;

      case ScrapelessErrorType.ELEMENT_NOT_FOUND:
        return `${this.message}\n\nSuggestions:\n- Take a snapshot first: scrapeless-scraping-browser snapshot -i\n- Wait for the element to load: scrapeless-scraping-browser wait "#selector"\n- Check if the element is in a different frame`;

      case ScrapelessErrorType.INVALID_SELECTOR:
        return `${this.message}\n\nSuggestions:\n- Use CSS selectors: "#id", ".class", "tag"\n- Use XPath: "//div[@class='example']"\n- Use element refs from snapshot: "@e1", "@e2"`;

      case ScrapelessErrorType.INVALID_CONFIGURATION:
        return `${this.message}\n\nSuggestions:\n- Check your configuration: scrapeless-scraping-browser config list\n- Review the documentation for valid configuration options`;

      default:
        return this.message;
    }
  }
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  backoffFactor: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 10000, // 10 seconds
  backoffFactor: 2,
};

/**
 * Retry a function with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const { maxAttempts, baseDelay, maxDelay, backoffFactor } = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
  };

  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Don't retry if it's not a retryable error
      if (error instanceof ScrapelessError && !error.retryable) {
        throw error;
      }

      // Don't retry on the last attempt
      if (attempt === maxAttempts) {
        break;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(baseDelay * Math.pow(backoffFactor, attempt - 1), maxDelay);

      // Add some jitter to prevent thundering herd
      const jitter = Math.random() * 0.1 * delay;
      const finalDelay = delay + jitter;

      console.debug(`Attempt ${attempt} failed, retrying in ${Math.round(finalDelay)}ms...`);
      await new Promise((resolve) => setTimeout(resolve, finalDelay));
    }
  }

  throw lastError!;
}
