import { AppError } from '../utils/errors.js';
import { config } from '../config.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No API route for ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed request body.' } });
  }
  // DB constraint backstops (should normally be caught earlier with a nicer message)
  if (err?.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
    return res.status(400).json({ error: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient demo balance.' } });
  }
  if (err?.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'That action has already been processed.' } });
  }
  if (!config.isTest || process.env.DEBUG_ERRORS) console.error(err);
  res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
}
