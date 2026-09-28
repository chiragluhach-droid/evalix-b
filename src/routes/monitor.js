import fs from 'node:fs';
import { Router } from 'express';
import { Attempt, Event, Exam, Flag, Frame, Notification } from '../models/index.js';
import { auth, requireRole } from '../middleware/auth.js';
import { logEvent, liveUpdate, submitAttempt } from '../services/attempts.js';
import { aiEnabled } from '../services/ai.js';
import { emitTo } from '../services/realtime.js';

const r = Router();
r.use(auth);

const canSee = (req, exam) => req.user.role === 'admin' || String(exam.createdBy) === req.user.id;

async function teacherAttempt(req, res) {
  const attempt = await Attempt.findById(req.params.id).populate('student', 'name email rollNo');
  if (!attempt) { res.status(404).json({ error: 'Attempt not found' }); return {}; }
  const exam = await Exam.findById(attempt.exam);
  if (!canSee(req, exam)) { res.status(403).json({ error: 'Forbidden' }); return {}; }
  return { attempt, exam };
}

r.get('/system', (_req, res) => res.json({ aiEnabled: aiEnabled() }));

r.get('/attempts/:id/report', requireRole('teacher', 'admin'), async (req, res) => {
  const { attempt, exam } = await teacherAttempt(req, res);
  if (!attempt) return;
  const [events, flags, frames] = await Promise.all([
    Event.find({ attempt: attempt._id }).sort({ at: 1 }).lean(),
    Flag.find({ attempt: attempt._id }).sort({ createdAt: -1 }).lean(),
    Frame.find({ attempt: attempt._id }).sort({ at: -1 }).limit(60).lean(),
  ]);
  const frameStats = await Frame.aggregate([{ $match: { attempt: attempt._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const c = attempt.counters;
  const confirmed = flags.some((f) => f.status === 'confirmed');
  const risk = (c.tabSwitches + c.fullscreenExits + c.copyPaste) + flags.filter((f) => f.status !== 'dismissed').length * 3 + (attempt.deviceChangedEver ? 3 : 0);
  const integrity = confirmed ? 'Cheating confirmed' : risk >= 8 ? 'Suspicious' : risk >= 3 ? 'Review' : 'Clean';
  res.json({
    attempt, exam: { _id: exam._id, title: exam.title, totalMarks: exam.totalMarks, settings: exam.settings, questions: exam.questions },
    events, flags, frames: frames.map((f) => ({ _id: f._id, status: f.status, trigger: f.trigger, at: f.at, analysis: f.analysis, error: f.error })),
    frameStats: Object.fromEntries(frameStats.map((s) => [s._id, s.n])), integrity, aiEnabled: aiEnabled(),
  });
});

r.post('/attempts/:id/action', requireRole('teacher', 'admin'), async (req, res) => {
  const { attempt } = await teacherAttempt(req, res);
  if (!attempt) return;
  const { action, minutes } = req.body || {};
  if (action === 'unlock') {
    if (attempt.status !== 'locked') return res.status(400).json({ error: 'Attempt is not locked' });
    attempt.status = 'in_progress';
    attempt.lockedReason = undefined;
    if (attempt.endsAt < new Date()) attempt.endsAt = new Date(Date.now() + 5 * 60000);
  } else if (action === 'extra_time') {
    attempt.endsAt = new Date(new Date(attempt.endsAt).getTime() + (Number(minutes) || 5) * 60000);
    emitTo(`attempt:${attempt._id}`, 'attempt:time', { endsAt: attempt.endsAt });
  } else if (action === 'force_submit') {
    await submitAttempt(attempt, 'teacher');
    await logEvent(attempt, 'teacher_action', { action, by: req.user.name });
    return res.json({ ok: true });
  } else return res.status(400).json({ error: 'Unknown action' });
  await attempt.save();
  await logEvent(attempt, 'teacher_action', { action, minutes, by: req.user.name });
  await liveUpdate(attempt);
  res.json({ ok: true, attempt });
});

r.get('/flags', requireRole('teacher', 'admin'), async (req, res) => {
  const q = req.user.role === 'admin' ? {} : { teacher: req.user.id };
  if (req.query.status) q.status = req.query.status;
  if (req.query.exam) q.exam = req.query.exam;
  res.json(await Flag.find(q).populate('student', 'name rollNo').populate('exam', 'title').sort({ createdAt: -1 }).limit(300).lean());
});

r.put('/flags/:id', requireRole('teacher', 'admin'), async (req, res) => {
  const flag = await Flag.findById(req.params.id);
  if (!flag) return res.status(404).json({ error: 'Flag not found' });
  if (req.user.role !== 'admin' && String(flag.teacher) !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const { status, note } = req.body || {};
  if (status && !['pending', 'confirmed', 'dismissed'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  if (status) flag.status = status;
  if (note !== undefined) flag.note = note;
  await flag.save();
  await Event.create({ attempt: flag.attempt, exam: flag.exam, student: flag.student, type: 'teacher_action', meta: { action: `flag_${flag.status}`, types: flag.types, by: req.user.name } });
  res.json(flag);
});

function sendImage(res, file) {
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(file);
}

r.get('/flags/:id/image', requireRole('teacher', 'admin'), async (req, res) => {
  const flag = await Flag.findById(req.params.id).lean();
  if (!flag || (req.user.role !== 'admin' && String(flag.teacher) !== req.user.id)) return res.status(404).end();
  sendImage(res, flag.imagePath);
});

r.get('/frames/:id/image', requireRole('teacher', 'admin'), async (req, res) => {
  const frame = await Frame.findById(req.params.id).lean();
  const exam = frame && (await Exam.findById(frame.exam).lean());
  if (!exam || !canSee(req, exam)) return res.status(404).end();
  sendImage(res, frame.path);
});

r.get('/attempts/:id/reference', requireRole('teacher', 'admin'), async (req, res) => {
  const { attempt } = await teacherAttempt(req, res);
  if (attempt) sendImage(res, attempt.referencePhoto);
});

r.get('/notifications', async (req, res) => {
  const list = await Notification.find({ user: req.user.id }).sort({ createdAt: -1 }).limit(30).lean();
  res.json({ list, unread: await Notification.countDocuments({ user: req.user.id, read: false }) });
});
r.post('/notifications/read', async (req, res) => {
  await Notification.updateMany({ user: req.user.id, read: false }, { read: true });
  res.json({ ok: true });
});

// Teacher dashboard numbers
r.get('/teacher/dashboard', requireRole('teacher', 'admin'), async (req, res) => {
  const exams = await Exam.find(req.user.role === 'admin' ? {} : { createdBy: req.user.id }).lean();
  const ids = exams.map((e) => e._id);
  const attempts = await Attempt.find({ exam: { $in: ids } }).populate('student', 'name rollNo').lean();
  const submitted = attempts.filter((a) => a.status === 'submitted');
  const pct = (a) => (a.totalMarks ? (a.score / a.totalMarks) * 100 : 0);
  const avg = submitted.length ? submitted.reduce((s, a) => s + pct(a), 0) / submitted.length : 0;
  const performance = exams
    .filter((e) => submitted.some((a) => String(a.exam) === String(e._id)))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map((e) => { const s = submitted.filter((a) => String(a.exam) === String(e._id)); return { name: e.title, avg: Math.round(s.reduce((x, a) => x + pct(a), 0) / s.length) }; });
  const byStudent = {};
  submitted.forEach((a) => { const k = String(a.student?._id); byStudent[k] ||= { name: a.student?.name, total: 0, n: 0 }; byStudent[k].total += pct(a); byStudent[k].n++; });
  const top = Object.values(byStudent).map((s) => ({ name: s.name, pct: Math.round(s.total / s.n) })).sort((a, b) => b.pct - a.pct).slice(0, 5);
  const dist = [[80, 101, '80–100%'], [60, 80, '60–80%'], [40, 60, '40–60%'], [0, 40, '0–40%']].map(([lo, hi, range]) => ({ range, count: submitted.filter((a) => pct(a) >= lo && pct(a) < hi).length }));
  const sum = (k) => attempts.reduce((s, a) => s + (a.counters?.[k] || 0), 0);
  const activity = await Event.aggregate([
    { $match: { exam: { $in: ids }, at: { $gte: new Date(Date.now() - 7 * 864e5) }, type: { $in: ['tab_hidden', 'window_blur', 'fullscreen_exit', 'copy_attempt', 'paste_attempt', 'ai_flag'] } } },
    { $group: { _id: { $dateToString: { format: '%m-%d', date: '$at' } }, count: { $sum: 1 } } }, { $sort: { _id: 1 } },
  ]);
  const pendingFlags = await Flag.countDocuments({ exam: { $in: ids }, status: 'pending' });
  res.json({
    totalExams: exams.length, students: new Set(attempts.map((a) => String(a.student?._id))).size,
    completed: submitted.length, avgScore: Math.round(avg * 10) / 10, liveNow: attempts.filter((a) => a.status === 'in_progress').length,
    pendingFlags, performance, top, distribution: dist, activity: activity.map((a) => ({ day: a._id, count: a.count })),
    suspicious: { tabSwitches: sum('tabSwitches'), fullscreenExits: sum('fullscreenExits'), copyPaste: sum('copyPaste'), aiFlags: sum('aiFlags'), disconnects: sum('disconnects'), deviceChanges: attempts.filter((a) => a.deviceChangedEver).length },
    recentExams: exams.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5).map((e) => ({ _id: e._id, title: e.title, status: e.status, createdAt: e.createdAt, students: attempts.filter((a) => String(a.exam) === String(e._id)).length })),
  });
});

export default r;
