import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Attempt, Exam, Flag, User } from '../models/index.js';
import { auth, requireRole } from '../middleware/auth.js';

const r = Router();
r.use(auth, requireRole('admin'));

r.get('/stats', async (_req, res) => {
  const [teachers, students, exams, published, attempts, flags] = await Promise.all([
    User.countDocuments({ role: 'teacher' }), User.countDocuments({ role: 'student' }),
    Exam.countDocuments(), Exam.countDocuments({ status: 'published' }),
    Attempt.countDocuments({ status: 'submitted' }), Flag.countDocuments({ status: 'pending' }),
  ]);
  const byDay = await Attempt.aggregate([
    { $match: { submittedAt: { $gte: new Date(Date.now() - 14 * 864e5) } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$submittedAt' } }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  res.json({ teachers, students, exams, published, attempts, pendingFlags: flags, byDay });
});

r.get('/users', async (req, res) => {
  const q = {};
  if (req.query.role) q.role = req.query.role;
  if (req.query.search) {
    const s = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [{ name: s }, { email: s }, { rollNo: s }];
  }
  res.json(await User.find(q).sort({ createdAt: -1 }).limit(500));
});

async function createOne({ name, email, password, role, rollNo, department }) {
  if (!name || !email || !password || !role) throw new Error('name, email, password and role are required');
  if (!['admin', 'teacher', 'student'].includes(role)) throw new Error('Invalid role');
  return User.create({ name, email, rollNo: rollNo || undefined, department, role, password: await bcrypt.hash(password, 10) });
}

r.post('/users', async (req, res) => {
  try { res.status(201).json(await createOne(req.body)); }
  catch (e) { res.status(400).json({ error: e.code === 11000 ? 'Email or roll number already exists' : e.message }); }
});

// CSV lines: name,email,password[,rollNo]
r.post('/users/bulk', async (req, res) => {
  const { csv, role } = req.body || {};
  const lines = String(csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const created = [];
  const errors = [];
  for (const [i, line] of lines.entries()) {
    const [name, email, password, rollNo] = line.split(',').map((s) => s?.trim());
    if (i === 0 && /^name$/i.test(name)) continue;
    try { created.push(await createOne({ name, email, password, rollNo, role: role || 'student' })); }
    catch (e) { errors.push(`Line ${i + 1}: ${e.code === 11000 ? 'duplicate email/roll no' : e.message}`); }
  }
  res.json({ created: created.length, errors });
});

r.put('/users/:id', async (req, res) => {
  const { name, email, rollNo, department, password } = req.body || {};
  const update = { name, email, rollNo: rollNo || undefined, department };
  if (password) update.password = await bcrypt.hash(password, 10);
  const u = await User.findByIdAndUpdate(req.params.id, update, { new: true });
  res.json(u);
});

r.delete('/users/:id', async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  await User.findByIdAndDelete(req.params.id);
  await Attempt.deleteMany({ student: req.params.id });
  res.json({ ok: true });
});

export default r;
