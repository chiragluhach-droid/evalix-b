import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/index.js';
import { auth, signToken } from '../middleware/auth.js';

const r = Router();

r.post('/login', async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: 'Email/roll number and password are required' });
  const id = String(identifier).trim();
  const user = await User.findOne({ $or: [{ email: id.toLowerCase() }, { rollNo: id }] });
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: signToken(user), user });
});

r.get('/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({ user });
});

r.put('/password', auth, async (req, res) => {
  const { current, next } = req.body || {};
  const user = await User.findById(req.user.id);
  if (!user || !(await bcrypt.compare(current || '', user.password))) return res.status(400).json({ error: 'Current password is wrong' });
  if (!next || next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  user.password = await bcrypt.hash(next, 10);
  await user.save();
  res.json({ ok: true });
});

export default r;
