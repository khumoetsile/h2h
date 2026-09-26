import { badRequest } from '../utils/errors.js';

/** Validate req[part] against a zod schema; replaces it with the parsed value. */
export const validate = (schema, part = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[part] ?? {});
  if (!result.success) {
    const fields = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    const first = Object.values(fields)[0];
    return next(badRequest('VALIDATION_ERROR', first || 'Please check the form and try again.', { fields }));
  }
  if (part === 'query') req.validatedQuery = result.data; else req[part] = result.data;
  next();
};
