import { Router } from 'express';
import { Attempt, Exam, Flag, Event } from '../models/index.js';
import { auth, requireRole } from '../middleware/auth.js';

const r = Router();
r.use(auth, requireRole('teacher', 'admin'));

export async function ownedExam(req, res) {
  const exam = await Exam.findById(req.params.id);
  if (!exam) { res.status(404).json({ error: 'Exam not found' }); return null; }
  if (req.user.role !== 'admin' && String(exam.createdBy) !== req.user.id) { res.status(403).json({ error: 'Not your exam' }); return null; }
  return exam;
}

const pick = (b) => ({
  title: b.title, description: b.description, subject: b.subject, durationMin: b.durationMin,
  startAt: b.startAt || null, endAt: b.endAt || null, resultsPublished: b.resultsPublished,
  questions: b.questions, settings: b.settings,
});

r.get('/', async (req, res) => {
  const q = req.user.role === 'admin' ? {} : { createdBy: req.user.id };
  const exams = await Exam.find(q).sort({ createdAt: -1 }).lean({ virtuals: true });
  const stats = await Attempt.aggregate([
    { $match: { exam: { $in: exams.map((e) => e._id) } } },
    { $group: { _id: '$exam', attempts: { $sum: 1 }, submitted: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
      live: { $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] } }, avg: { $avg: '$score' } } },
  ]);
  const m = Object.fromEntries(stats.map((s) => [String(s._id), s]));
  res.json(exams.map((e) => ({
    ...e, questionCount: e.questions.length, totalMarks: e.questions.reduce((s, q) => s + q.marks, 0), questions: undefined,
    attempts: m[e._id]?.attempts || 0, submitted: m[e._id]?.submitted || 0, live: m[e._id]?.live || 0, avgScore: m[e._id]?.avg ?? null,
  })));
});

r.post('/', async (req, res) => {
  try {
    const exam = await Exam.create({ ...pick(req.body), createdBy: req.user.id });
    res.status(201).json(exam);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

r.get('/:id', async (req, res) => {
  const exam = await ownedExam(req, res);
  if (exam) res.json(exam);
});

r.put('/:id', async (req, res) => {
  const exam = await ownedExam(req, res);
  if (!exam) return;
  const started = await Attempt.exists({ exam: exam._id });
  const body = pick(req.body);
  if (started && body.questions) delete body.questions; // don't change questions under students' feet
  Object.entries(body).forEach(([k, v]) => v !== undefined && exam.set(k, v));
  try { await exam.save(); res.json({ exam, questionsLocked: Boolean(started) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

r.post('/:id/status', async (req, res) => {
  const exam = await ownedExam(req, res);
  if (!exam) return;
  const { status } = req.body;
  if (!['draft', 'published', 'closed'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  if (status === 'published' && !exam.questions.length) return res.status(400).json({ error: 'Add at least one question first' });
  exam.status = status;
  await exam.save();
  res.json(exam);
});

r.delete('/:id', async (req, res) => {
  const exam = await ownedExam(req, res);
  if (!exam) return;
  await Promise.all([Attempt.deleteMany({ exam: exam._id }), Flag.deleteMany({ exam: exam._id }), Event.deleteMany({ exam: exam._id }), exam.deleteOne()]);
  res.json({ ok: true });
});

// Attempts roster (used for results + live monitoring)
r.get('/:id/attempts', async (req, res) => {
  const exam = await ownedExam(req, res);
  if (!exam) return;
  const attempts = await Attempt.find({ exam: exam._id }).populate('student', 'name email rollNo').sort({ startedAt: -1 }).lean();
  const flags = await Flag.aggregate([
    { $match: { exam: exam._id } },
    { $group: { _id: '$attempt', total: { $sum: 1 }, pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
      confirmed: { $sum: { $cond: [{ $eq: ['$status', 'confirmed'] }, 1, 0] } } } },
  ]);
  const fm = Object.fromEntries(flags.map((f) => [String(f._id), f]));
  res.json(attempts.map((a) => {
    const last = a.sessions?.[a.sessions.length - 1];
    return {
      _id: a._id, student: a.student, status: a.status, score: a.score, totalMarks: a.totalMarks ?? exam.totalMarks,
      startedAt: a.startedAt, submittedAt: a.submittedAt, submitReason: a.submitReason, endsAt: a.endsAt,
      answered: Object.keys(a.answers || {}).length, counters: a.counters, resumeCount: a.resumeCount,
      deviceChangedEver: a.deviceChangedEver, lockedReason: a.lockedReason, lastFrameAt: a.lastFrameAt,
      online: a.status === 'in_progress' && last && !last.endedAt && Date.now() - new Date(last.lastSeenAt) < 30000,
      flags: fm[String(a._id)] || { total: 0, pending: 0, confirmed: 0 },
    };
  }));
});

r.get('/:id/analytics', async (req, res) => {
  const exam = await ownedExam(req, res);
  if (!exam) return;
  const attempts = await Attempt.find({ exam: exam._id, status: 'submitted' }).populate('student', 'name rollNo').lean();
  const total = exam.questions.reduce((s, q) => s + q.marks, 0) || 1;
  const pct = attempts.map((a) => (a.score / total) * 100);
  const dist = [
    { range: '80–100%', count: pct.filter((p) => p >= 80).length },
    { range: '60–80%', count: pct.filter((p) => p >= 60 && p < 80).length },
    { range: '40–60%', count: pct.filter((p) => p >= 40 && p < 60).length },
    { range: '0–40%', count: pct.filter((p) => p < 40).length },
  ];
  const perQuestion = exam.questions.map((q, i) => {
    const answered = attempts.filter((a) => a.answers?.[i] !== undefined);
    const correct = answered.filter((a) => a.answers[i] === q.correctIndex).length;
    return { index: i + 1, topic: q.topic, text: q.text.slice(0, 60), answered: answered.length, correct, accuracy: answered.length ? Math.round((correct / answered.length) * 100) : 0 };
  });
  const topics = {};
  perQuestion.forEach((p) => { topics[p.topic] ||= { topic: p.topic, answered: 0, correct: 0 }; topics[p.topic].answered += p.answered; topics[p.topic].correct += p.correct; });
  const top = [...attempts].sort((a, b) => b.score - a.score).slice(0, 5).map((a) => ({ name: a.student?.name, rollNo: a.student?.rollNo, score: a.score, pct: Math.round((a.score / total) * 100) }));
  res.json({
    submitted: attempts.length, totalMarks: total,
    average: pct.length ? Math.round(pct.reduce((s, p) => s + p, 0) / pct.length * 10) / 10 : 0,
    passRate: pct.length ? Math.round((pct.filter((p) => p >= 40).length / pct.length) * 100) : 0,
    highest: pct.length ? Math.round(Math.max(...pct)) : 0,
    distribution: dist, perQuestion, top,
    topics: Object.values(topics).map((t) => ({ ...t, accuracy: t.answered ? Math.round((t.correct / t.answered) * 100) : 0 })),
  });
});

r.get('/:id/export', async (req, res) => {
  const exam = await ownedExam(req, res);
  if (!exam) return;
  const attempts = await Attempt.find({ exam: exam._id }).populate('student', 'name email rollNo').lean();
  const flags = await Flag.find({ exam: exam._id }).lean();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Name', 'Roll No', 'Email', 'Status', 'Score', 'Total', 'Percent', 'Submitted At', 'Submit Reason', 'Tab Switches',
    'Fullscreen Exits', 'Copy/Paste', 'Disconnects', 'Resumes', 'Device Changed', 'AI Flags', 'Confirmed Cheating']];
  for (const a of attempts) {
    const af = flags.filter((f) => String(f.attempt) === String(a._id));
    const total = a.totalMarks || exam.questions.reduce((s, q) => s + q.marks, 0);
    rows.push([a.student?.name, a.student?.rollNo, a.student?.email, a.status, a.score ?? '', total,
      a.score != null ? Math.round((a.score / total) * 100) : '', a.submittedAt?.toISOString() || '', a.submitReason || '',
      a.counters?.tabSwitches, a.counters?.fullscreenExits, a.counters?.copyPaste, a.counters?.disconnects, a.resumeCount,
      a.deviceChangedEver ? 'Yes' : 'No', af.length, af.filter((f) => f.status === 'confirmed').length ? 'Yes' : 'No']);
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${exam.title.replace(/[^\w]+/g, '_')}_results.csv"`);
  res.send(rows.map((r) => r.map(esc).join(',')).join('\n'));
});

export default r;
