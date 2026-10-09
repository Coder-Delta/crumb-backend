import jwt from 'jsonwebtoken';
import { User } from './models.js';

export async function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ message: 'Please sign in to continue.' });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(payload.sub);
    if (!req.user || !req.user.active) return res.status(401).json({ message: 'Account not found or disabled.' });
    next();
  } catch { return res.status(401).json({ message: 'Your session has expired. Please sign in again.' }); }
}
export function admin(req, res, next) { if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access required.' }); next(); }
export function errorHandler(err, req, res, next) {
  if (err?.name === 'ZodError') return res.status(400).json({ message: 'Please check the details and try again.', errors: err.errors.map(e => ({ field: e.path.join('.'), message: e.message })) });
  if (err?.code === 11000) return res.status(409).json({ message: 'An account with this email already exists.' });
  if (err?.name === 'ValidationError') return res.status(400).json({ message: err.message });
  console.error(err);
  res.status(err.status || 500).json({ message: err.status ? err.message : 'Something went wrong. Please try again.' });
}
