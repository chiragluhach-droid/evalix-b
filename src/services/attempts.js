import { Attempt, Event, Exam, User } from '../models/index.js';
import { emitTo } from './realtime.js';
import { notify } from './notify.js';

export function grade(exam, attempt) {
  let score = 0;
  let correct = 0;
  const neg = exam.settings?.negativeMarking || 0;
  exam.questions.forEach((q, i) => {
    const a = attempt.answers.get(String(i));
    if (a === undefined || a === null) return;
    if (a === q.correctIndex) { score += q.marks; correct += 1; } else score -= neg;
  });
  return { score: Math.round(score * 100) / 100, correctCount: correct, totalMarks: exam.questions.reduce((s, q) => s + q.marks, 0) };
}

export async function logEvent(attempt, type, meta = {}, extra = {}) {
  return Event.create({
    attempt: attempt._id, exam: attempt.exam, student: attempt.student,
    sessionId: extra.sessionId ?? attempt.activeSessionId, type, meta, questionIndex: extra.questionIndex,
    at: extra.at || new Date(),
  });
}

export async function liveUpdate(attempt, extra = {}) {
  emitTo(`exam:${attempt.exam}`, 'student:update', {
    attemptId: String(attempt._id), status: attempt.status, counters: attempt.counters,
    resumeCount: attempt.resumeCount, deviceChangedEver: attempt.deviceChangedEver,
    answered: attempt.answers?.size ?? 0, ...extra,
  });
}

export async function submitAttempt(attempt, reason = 'manual') {
  if (attempt.status === 'submitted') return attempt;
  const exam = await Exam.findById(attempt.exam);
  Object.assign(attempt, grade(exam, attempt), { status: 'submitted', submittedAt: new Date(), submitReason: reason });
  const s = attempt.sessions.find((x) => x.sessionId === attempt.activeSessionId);
  if (s && !s.endedAt) { s.endedAt = new Date(); s.endReason = 'submitted'; }
  await attempt.save();
  await logEvent(attempt, 'submitted', { reason, score: attempt.score });
  await liveUpdate(attempt, { online: false });
  emitTo(`attempt:${attempt._id}`, 'attempt:submitted', { reason });
  return attempt;
}

export async function lockAttempt(attempt, reason) {
  attempt.status = 'locked';
  attempt.lockedReason = reason;
  await attempt.save();
  await logEvent(attempt, 'locked', { reason });
  await liveUpdate(attempt, { online: false });
  const [exam, student] = await Promise.all([Exam.findById(attempt.exam).lean(), User.findById(attempt.student).lean()]);
  await notify(exam.createdBy, {
    title: `Attempt locked — ${student?.name}`,
    body: `${exam.title}: ${reason}. You can unlock it from the attempt page.`,
    link: `/teacher/attempts/${attempt._id}`,
    kind: 'warning',
  });
}

// Auto-submit attempts whose time ran out (e.g. student closed the tab).
export function startExpiryWatcher() {
  setInterval(async () => {
    const expired = await Attempt.find({ status: { $in: ['in_progress', 'locked'] }, endsAt: { $lt: new Date(Date.now() - 10000) } });
    for (const a of expired) await submitAttempt(a, 'timeout').catch(() => {});
  }, 30000);
}
