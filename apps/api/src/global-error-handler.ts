import type { ErrorRequestHandler } from 'express';
import { operationalFailureMeta, type Logger } from '@skytwin/core';

/**
 * Last-resort API boundary. The throwable may contain provider response bodies,
 * source content, credentials, or SQL details, so neither message nor stack is
 * read here. Detailed diagnostics belong in a deliberately redacted subsystem
 * boundary before an error reaches this middleware.
 */
export function createGlobalErrorHandler(
  log: Pick<Logger, 'error'>,
): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    log.error('Unhandled API request error', operationalFailureMeta(err));
    res.status(500).json({
      error: 'internal_error',
      message: 'Something went wrong on our end.',
    });
  };
}
