import { ZodError } from 'zod';

export const validate = (schema) => (req, res, next) => {
  try {
    // Allow schemas to validate body, query, and params together
    const toValidate = { body: req.body, query: req.query, params: req.params };
    const parsed = schema.parse(toValidate);
    req.validated = parsed; // attach validated data for handlers
    return next();
  } catch (err) {
    if (err instanceof ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    return next(err);
  }
};

export default validate;
