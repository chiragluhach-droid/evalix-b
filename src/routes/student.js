import { Router } from 'express';
import { UAParser } from 'ua-parser-js';
import { Attempt, Exam, Frame, User } from '../models/index.js';
import { auth, requireRole } from '../middleware/auth.js';
import { liveUpdate, lockAttempt, logEvent, submitAttempt } from '../services/attempts.js';
import { aiEnabled, enqueueFrame } from '../services/ai.js';
import { notify } from '../services/notify.js';
import { emitTo } from '../services/realtime.js';
import { saveDataUrl } from '../services/storage.js';

const r = Router();
r.use(auth, requireRole('student'));

const now = () => new Date();
const isOpen = (e) => e.status === 'published' && (!e.startAt || e.startAt <= now()) && (!e.endAt || e.endAt >= now());

r.get('/exams', async (req, res) => {
  const exams = await Exam.find({ status: { $in: ['published', 'closed'] } }).populate('createdBy', 'name').sort({ startAt: -1, createdAt: -1 }).lean();
  const attempts = await Attempt.find({ student: req.user.id }).lean();
  const am = Object.fromEntries(attempts.map((a) => [String(a.exam), a]));
  res.json(exams
    .filter((e) => e.status === 'published' || am[e._id])
    .map((e) => {
      const a = am[e._id];
      return {
        _id: e._id, title: e.title, subject: e.subject, description: e.description, durationMin: e.durationMin,
        startAt: e.startAt, endAt: e.endAt, teacher: e.createdBy?.name, questionCount: e.questions.length,
        totalMarks: e.questions.reduce((s, q) => s + q.marks, 0), open: isOpen(e), upcoming: e.startAt && e.startAt > now(),
        aiProctoring: e.settings?.aiProctoring,
        attempt: a ? { _id: a._id, status: a.status, score: e.resultsPublished ? a.score : undefined, resumeCount: a.resumeCount } : null,
      };
    }));
});

r.get('/exams/:id', async (req, res) => {
  const e = await Exam.findById(req.params.id).populate('createdBy', 'name').lean();
  if (!e || e.status === 'draft') return res.status(404).json({ error: 'Exam not found' });
  const a = await Attempt.findOne({ exam: e._id, student: req.user.id }).lean();
  res.json({
    _id: e._id, title: e.title, subject: e.subject, description: e.description, durationMin: e.durationMin, startAt: e.startAt, endAt: e.endAt,
    teacher: e.createdBy?.name, questionCount: e.questions.length, totalMarks: e.questions.reduce((s, q) => s + q.marks, 0),
    settings: e.settings, open: isOpen(e), aiEnabled: aiEnabled(),
    attempt: a ? { _id: a._id, status: a.status, resumeCount: a.resumeCount, lockedReason: a.lockedReason } : null,
  });
});

function clientInfo(req, body) {
  const ua = UAParser(req.headers['user-agent'] || '');
  return {
    sessionId: String(body.sessionId || ''),
    deviceId: String(body.deviceId || ''),
    fingerprint: String(body.fingerprint || ''),
    browser: [ua.browser?.name, ua.browser?.major].filter(Boolean).join(' ') || 'Unknown',
    os: [ua.os?.name, ua.os?.version].filter(Boolean).join(' ') || 'Unknown',
    ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
    screen: body.screen, timezone: body.timezone,
  };
}

function studentView(exam, attempt) {
  return {
    attempt: {
      _id: attempt._id, status: attempt.status, endsAt: attempt.endsAt, startedAt: attempt.startedAt,
      answers: Object.fromEntries(attempt.answers), marked: attempt.marked, currentIndex: attempt.currentIndex,
      questionOrder: attempt.questionOrder, resumeCount: attempt.resumeCount, counters: attempt.counters,
      sessionId: attempt.activeSessionId,
    },
    exam: { _id: exam._id, title: exam.title, durationMin: exam.durationMin, settings: exam.settings, totalMarks: exam.totalMarks },
    // Questions in the frozen order; `index` is the original index used for answers. Correct answers never leave the server.
    questions: attempt.questionOrder.map((i) => {
      const q = exam.questions[i];
      return { index: i, text: q.text, code: q.code, options: q.options, marks: q.marks, topic: q.topic };
    }),
    aiEnabled: aiEnabled(),
    serverNow: new Date(),
  };
}

// Start a new attempt or resume an existing one.
r.post('/exams/:id/start', async (req, res) => {
  const exam = await Exam.findById(req.params.id);
  if (!exam || exam.status === 'draft') return res.status(404).json({ error: 'Exam not found' });
  const info = clientInfo(req, req.body || {});
  if (!info.sessionId || !info.deviceId) return res.status(400).json({ error: 'Missing session/device info' });
  const s = exam.settings;
  let attempt = await Attempt.findOne({ exam: exam._id, student: req.user.id });

  if (!attempt) {
    if (!isOpen(exam)) return res.status(400).json({ error: 'This exam is not open right now' });
    if (s.aiProctoring && !req.body.referencePhoto) return res.status(400).json({ error: 'A camera photo is required to start this exam', code: 'NEED_PHOTO' });
    const order = exam.questions.map((_q, i) => i);
    if (s.shuffleQuestions) order.sort(() => Math.random() - 0.5);
    const startedAt = now();
    let endsAt = new Date(startedAt.getTime() + exam.durationMin * 60000);
    if (exam.endAt && exam.endAt < endsAt) endsAt = exam.endAt;
    attempt = new Attempt({
      exam: exam._id, student: req.user.id, questionOrder: order, startedAt, endsAt, totalMarks: exam.totalMarks,
      sessions: [{ ...info, startedAt, lastSeenAt: startedAt }], activeSessionId: info.sessionId,
    });
    if (req.body.referencePhoto) {
      try { attempt.referencePhoto = saveDataUrl(req.body.referencePhoto, 'ref'); } catch (e) { return res.status(400).json({ error: e.message }); }
    }
    try { await attempt.save(); } catch (e) {
      if (e.code === 11000) return res.status(409).json({ error: 'Attempt already started, please retry' });
      throw e;
    }
    await logEvent(attempt, 'exam_started', { browser: info.browser, os: info.os, ip: info.ip, screen: info.screen }, { sessionId: info.sessionId });
    await liveUpdate(attempt, { online: true, joined: true });
    return res.json({ ...studentView(exam, attempt), session: { isResume: false } });
  }

  if (attempt.status === 'submitted') return res.status(400).json({ error: 'You have already submitted this exam', code: 'SUBMITTED' });
  if (attempt.endsAt < now()) {
    await submitAttempt(attempt, 'timeout');
    return res.status(400).json({ error: 'Time is over — your exam was submitted automatically', code: 'SUBMITTED' });
  }
  if (attempt.status === 'locked') return res.status(423).json({ error: `Your attempt is locked: ${attempt.lockedReason || 'contact your teacher'}. Ask your teacher to unlock it.`, code: 'LOCKED' });

  // Same browser session reconnecting (page refresh inside the same tab) is not a resume.
  const prev = attempt.sessions[attempt.sessions.length - 1];
  if (prev && prev.sessionId === info.sessionId) {
    prev.lastSeenAt = now();
    prev.endedAt = undefined;
    prev.endReason = undefined;
    attempt.activeSessionId = info.sessionId;
    await attempt.save();
    await logEvent(attempt, 'reconnected', {}, { sessionId: info.sessionId });
    await liveUpdate(attempt, { online: true });
    return res.json({ ...studentView(exam, attempt), session: { isResume: false, reconnected: true } });
  }

  // ---- a real resume (new tab / browser / device) ----
  const first = attempt.sessions[0];
  const deviceChanged = Boolean(first) && (first.deviceId !== info.deviceId || prev.deviceId !== info.deviceId);
  const browserChanged = Boolean(prev) && prev.browser !== info.browser;
  const ipChanged = Boolean(prev) && prev.ip !== info.ip;
  const awaySeconds = prev ? Math.max(0, Math.round((now() - new Date(prev.lastSeenAt)) / 1000)) : 0;
  const student = await User.findById(req.user.id).lean();

  const reject = async (reason, code) => {
    await logEvent(attempt, 'resume_blocked', { reason, deviceChanged, browserChanged, ipChanged, browser: info.browser, os: info.os, ip: info.ip }, { sessionId: info.sessionId });
    await notify(exam.createdBy, { title: `Resume blocked — ${student?.name}`, body: `${exam.title}: ${reason}`, link: `/teacher/attempts/${attempt._id}`, kind: 'warning' });
    return res.status(403).json({ error: reason, code });
  };
  if (s.resumePolicy === 'not_allowed') {
    await lockAttempt(attempt, 'Left the exam (resume not allowed)');
    return res.status(423).json({ error: 'This exam does not allow resuming. Your attempt is locked — ask your teacher to unlock it.', code: 'LOCKED' });
  }
  if (attempt.resumeCount >= s.maxResumes) return reject(`Maximum resumes (${s.maxResumes}) reached`, 'MAX_RESUMES');
  if (deviceChanged && s.blockNewDeviceResume) return reject('Resuming from a different device is not allowed for this exam', 'DEVICE_BLOCKED');

  const wasActive = Boolean(prev && !prev.endedAt && now() - new Date(prev.lastSeenAt) < 30000);
  if (prev && !prev.endedAt) { prev.endedAt = now(); prev.endReason = 'taken_over'; }
  emitTo(`attempt:${attempt._id}`, 'session:ended', { sessionId: prev?.sessionId, reason: 'taken_over' });
  attempt.sessions.push({ ...info, isResume: true, deviceChanged, browserChanged, ipChanged, awaySeconds });
  attempt.activeSessionId = info.sessionId;
  attempt.resumeCount += 1;
  if (deviceChanged) attempt.deviceChangedEver = true;
  await attempt.save();

  await logEvent(attempt, 'resumed', {
    resumeNo: attempt.resumeCount, awaySeconds, deviceChanged, browserChanged, ipChanged,
    browser: info.browser, os: info.os, ip: info.ip, previousBrowser: prev?.browser, previousIp: prev?.ip,
  }, { sessionId: info.sessionId });
  if (deviceChanged) await logEvent(attempt, 'device_changed', { from: prev?.deviceId?.slice(0, 8), to: info.deviceId.slice(0, 8) }, { sessionId: info.sessionId });
  if (wasActive) await logEvent(attempt, 'concurrent_login', { previousSession: prev.sessionId }, { sessionId: info.sessionId });
  await liveUpdate(attempt, { online: true, resumed: true });
  emitTo(`exam:${exam._id}`, 'alert', {
    kind: deviceChanged ? 'device_changed' : 'resumed', attemptId: String(attempt._id), student: student?.name,
    reason: `Resumed (#${attempt.resumeCount}) after ${awaySeconds}s — device changed: ${deviceChanged ? 'YES' : 'no'}`, at: now(),
  });
  await notify(exam.createdBy, {
    title: `${deviceChanged ? '⚠ Device changed on resume' : 'Exam resumed'} — ${student?.name}`,
    body: `${exam.title}: resume #${attempt.resumeCount}, away ${awaySeconds}s. Device changed: ${deviceChanged ? 'Yes' : 'No'}, browser changed: ${browserChanged ? 'Yes' : 'No'}, IP changed: ${ipChanged ? 'Yes' : 'No'}.`,
    link: `/teacher/attempts/${attempt._id}`,
    kind: deviceChanged ? 'alert' : 'info',
  });
  res.json({ ...studentView(exam, attempt), session: { isResume: true, deviceChanged, browserChanged, ipChanged, awaySeconds, resumeNo: attempt.resumeCount } });
});

// Loads the attempt and checks it is still active for this browser session.
async function activeAttempt(req, res) {
  const attempt = await Attempt.findOne({ _id: req.params.id, student: req.user.id });
  if (!attempt) { res.status(404).json({ error: 'Attempt not found' }); return null; }
  if (attempt.status === 'submitted') { res.status(409).json({ error: 'Exam already submitted', code: 'SUBMITTED' }); return null; }
  if (attempt.status === 'locked') { res.status(423).json({ error: 'Attempt locked', code: 'LOCKED' }); return null; }
  if (req.body?.sessionId !== attempt.activeSessionId) { res.status(409).json({ error: 'This exam was opened somewhere else', code: 'SESSION_REPLACED' }); return null; }
  if (attempt.endsAt < now()) { await submitAttempt(attempt, 'timeout'); res.status(409).json({ error: 'Time is over', code: 'SUBMITTED' }); return null; }
  const s = attempt.sessions.find((x) => x.sessionId === attempt.activeSessionId);
  if (s) s.lastSeenAt = now();
  return attempt;
}

r.post('/attempts/:id/answer', async (req, res) => {
  const attempt = await activeAttempt(req, res);
  if (!attempt) return;
  const { questionIndex, choice, currentIndex, marked } = req.body;
  if (questionIndex !== undefined) {
    const key = String(questionIndex);
    const had = attempt.answers.has(key);
    if (choice === null || choice === undefined) attempt.answers.delete(key);
    else attempt.answers.set(key, Number(choice));
    await logEvent(attempt, had ? 'answer_changed' : 'answer_saved', { choice }, { questionIndex });
  }
  if (currentIndex !== undefined) attempt.currentIndex = currentIndex;
  if (Array.isArray(marked)) attempt.marked = marked;
  await attempt.save();
  await liveUpdate(attempt, { online: true });
  res.json({ ok: true, savedAt: now() });
});

const CLIENT_EVENTS = new Set(['instructions_accepted', 'tab_hidden', 'tab_visible', 'window_blur', 'window_focus', 'fullscreen_exit', 'fullscreen_enter',
  'copy_attempt', 'cut_attempt', 'paste_attempt', 'right_click', 'devtools_attempt', 'print_attempt', 'multi_monitor', 'window_resize', 'offline', 'online',
  'camera_denied', 'camera_lost', 'camera_restored', 'question_visited', 'section_changed', 'warning_shown']);
const COUNTER = { tab_hidden: 'tabSwitches', window_blur: 'tabSwitches', fullscreen_exit: 'fullscreenExits', copy_attempt: 'copyPaste', cut_attempt: 'copyPaste', paste_attempt: 'copyPaste' };

r.post('/attempts/:id/events', async (req, res) => {
  const attempt = await activeAttempt(req, res);
  if (!attempt) return;
  const exam = await Exam.findById(attempt.exam).lean();
  const events = (req.body.events || []).filter((e) => CLIENT_EVENTS.has(e.type)).slice(0, 50);
  for (const e of events) {
    if (COUNTER[e.type]) attempt.counters[COUNTER[e.type]] += 1;
    await logEvent(attempt, e.type, e.meta || {}, { questionIndex: e.questionIndex, at: e.at ? new Date(e.at) : undefined });
  }
  const serious = events.filter((e) => COUNTER[e.type] || e.type.startsWith('camera') || e.type === 'multi_monitor');
  if (serious.length) {
    emitTo(`exam:${exam._id}`, 'alert', { kind: 'violation', attemptId: String(attempt._id), types: serious.map((e) => e.type), at: now() });
  }
  await attempt.save();
  const s = exam.settings;
  let autoSubmitted = false;
  if (s.autoSubmitOnLimit && s.maxTabSwitches > 0 && attempt.counters.tabSwitches > s.maxTabSwitches) {
    await submitAttempt(attempt, 'violation');
    autoSubmitted = true;
  } else await liveUpdate(attempt, { online: true });
  res.json({ ok: true, counters: attempt.counters, autoSubmitted, remainingTabSwitches: s.maxTabSwitches ? Math.max(0, s.maxTabSwitches - attempt.counters.tabSwitches) : null });
});

r.post('/attempts/:id/frame', async (req, res) => {
  const attempt = await activeAttempt(req, res);
  if (!attempt) return;
  const trigger = String(req.body.trigger || 'interval');
  if (trigger === 'interval' && attempt.lastFrameAt && now() - attempt.lastFrameAt < 8000) return res.json({ ok: true, skipped: true });
  let path;
  try { path = saveDataUrl(req.body.image); } catch (e) { return res.status(400).json({ error: e.message }); }
  const frame = await Frame.create({
    attempt: attempt._id, exam: attempt.exam, student: attempt.student, sessionId: attempt.activeSessionId,
    trigger, path, status: aiEnabled() ? 'pending' : 'skipped',
  });
  attempt.lastFrameAt = now();
  await attempt.save();
  enqueueFrame(frame._id, trigger !== 'interval');
  emitTo(`exam:${attempt.exam}`, 'frame', { attemptId: String(attempt._id), frameId: String(frame._id), status: frame.status });
  res.json({ ok: true });
});

r.post('/attempts/:id/submit', async (req, res) => {
  const attempt = await activeAttempt(req, res);
  if (!attempt) return;
  await submitAttempt(attempt, 'manual');
  res.json({ ok: true, attemptId: attempt._id });
});

r.get('/results', async (req, res) => {
  const attempts = await Attempt.find({ student: req.user.id, status: 'submitted' }).populate('exam', 'title subject resultsPublished questions').sort({ submittedAt: 1 }).lean();
  res.json(attempts.filter((a) => a.exam).map((a) => ({
    _id: a._id, examId: a.exam._id, title: a.exam.title, subject: a.exam.subject, submittedAt: a.submittedAt,
    published: a.exam.resultsPublished,
    score: a.exam.resultsPublished ? a.score : null, totalMarks: a.totalMarks,
    pct: a.exam.resultsPublished && a.totalMarks ? Math.round((a.score / a.totalMarks) * 100) : null,
  })));
});

r.get('/results/:attemptId', async (req, res) => {
  const a = await Attempt.findOne({ _id: req.params.attemptId, student: req.user.id, status: 'submitted' }).lean();
  if (!a) return res.status(404).json({ error: 'Result not found' });
  const exam = await Exam.findById(a.exam).lean();
  if (!exam.resultsPublished) return res.json({ published: false, title: exam.title });
  const questions = exam.questions.map((q, i) => ({
    index: i, text: q.text, code: q.code, options: q.options, marks: q.marks, topic: q.topic, explanation: q.explanation,
    correctIndex: q.correctIndex, yourAnswer: a.answers?.[i] ?? null, correct: a.answers?.[i] === q.correctIndex,
  }));
  const topics = {};
  questions.forEach((q) => { topics[q.topic] ||= { topic: q.topic, total: 0, correct: 0 }; topics[q.topic].total++; if (q.correct) topics[q.topic].correct++; });
  // class average for comparison
  const all = await Attempt.find({ exam: exam._id, status: 'submitted' }, 'score').lean();
  res.json({
    published: true, title: exam.title, score: a.score, totalMarks: a.totalMarks, correctCount: a.correctCount,
    answered: Object.keys(a.answers || {}).length, questionCount: exam.questions.length, submittedAt: a.submittedAt, submitReason: a.submitReason,
    classAverage: all.length ? Math.round((all.reduce((s, x) => s + x.score, 0) / all.length) * 10) / 10 : null,
    rank: all.filter((x) => x.score > a.score).length + 1, participants: all.length,
    topics: Object.values(topics).map((t) => ({ ...t, accuracy: Math.round((t.correct / t.total) * 100) })),
    questions,
  });
});

export default r;
