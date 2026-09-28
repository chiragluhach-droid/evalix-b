import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const signToken = (u) =>
  jwt.sign({ id: String(u._id), role: u.role, name: u.name, email: u.email }, config.jwtSecret, { expiresIn: '24h' });

export function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired, please log in again' });
  }
}

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'Forbidden' });
