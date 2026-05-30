export default function errorHandler(err, req, res, next) {
  try {
    console.error('Unhandled error:', err);
    const status = err.status || err.statusCode || 500;
    const message = err.message || 'Internal server error';

    if (process.env.NODE_ENV !== 'production') {
      return res.status(status).json({ success: false, message, stack: err.stack });
    }

    return res.status(status).json({ success: false, message });
  } catch (handlerErr) {
    console.error('Error in errorHandler:', handlerErr);
    return res.status(500).json({ success: false, message: 'Fatal error' });
  }
}
