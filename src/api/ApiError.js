/**
 * A non-success HTTP response from the claude.ai API.
 */
export class ApiError extends Error {
  /**
   * Creates the error.
   * @param {number} status HTTP status code.
   * @param {string} responseBody Response body; its first 200 characters become part of the message.
   */
  constructor(status, responseBody) {
    super(`${status} ${responseBody.slice(0, 200)}`.trim());
    this.name = 'ApiError';
    this.status = status;
  }

  /**
   * Creates an error from a failed response, including its body when readable.
   * @param {Response} response The failed response.
   * @returns {Promise<ApiError>} The error.
   */
  static async fromResponse(response) {
    return new ApiError(response.status, await response.text().catch(() => ''));
  }
}
