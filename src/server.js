import http from 'node:http';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { config } from './config.js';
import { Attempt, Exam } from './models/index.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import examRoutes from './routes/exams.js';
import studentRoutes from './routes/student.js';
import monitorRoutes from './routes/monitor.js';
import { setIO } from './services/realtime.js';
import { liveUpdate, lockAttempt, logEvent, startExpiryWatcher } from './services/attempts.js';
import { aiEnabled } from './services/ai.js';

const app = express();
app.set('trust proxy', true);
// Allow any origin (auth is via Bearer token, not cookies). CLIENT_URL is only used for links in emails.
app.use(cors({ origin: true }));
app.use(express.json({ limit: '6mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, ai: aiEnabled() }));
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/exams', examRoutes);
app.use('/api/student', studentRoutes);
app.use('/api', monitorRoutes);
app.use((err, _req, res, _next) => {
  if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid id' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
setIO(io);

io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth?.token, config.jwtSecret);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

// attemptId -> timer that fires if the student doesn't come back within the grace period
const disconnectTimers = new Map();
const GRACE_MS = 20000;

io.on('connection', (socket) => {
  const u = socket.user;
  socket.join(`user:${u.id}`);

  socket.on('teacher:watch', async (examId) => {
    if (u.role === 'student') return;
    const exam = await Exam.findById(examId).lean().catch(() => null);
    if (exam && (u.role === 'admin' || String(exam.createdBy) === u.id)) socket.join(`exam:${examId}`);
  });

  socket.on('student:join', async ({ attemptId, sessionId }) => {
    const attempt = await Attempt.findOne({ _id: attemptId, student: u.id }).catch(() => null);
    if (!attempt) return;
    socket.data.attemptId = attemptId;
    socket.data.sessionId = sessionId;
    socket.join(`attempt:${attemptId}`);
    const t = disconnectTimers.get(attemptId);
    if (t && t.sessionId === sessionId) { clearTimeout(t.timer); disconnectTimers.delete(attemptId); }
  });

  socket.on('heartbeat', async () => {
    const { attemptId, sessionId } = socket.data;
    if (!attemptId) return;
    await Attempt.updateOne(
      { _id: attemptId, activeSessionId: sessionId, status: 'in_progress' },
      { $set: { 'sessions.$[s].lastSeenAt': new Date() } },
      { arrayFilters: [{ 's.sessionId': sessionId }] }
    ).catch(() => {});
    io.to(`exam:${(await Attempt.findById(attemptId, 'exam').lean())?.exam}`).emit('student:update', { attemptId, online: true, heartbeat: true });
  });

  socket.on('disconnect', () => {
    const { attemptId, sessionId } = socket.data;
    if (!attemptId) return;
    const timer = setTimeout(async () => {
      disconnectTimers.delete(attemptId);
      const attempt = await Attempt.findById(attemptId);
      if (!attempt || attempt.status !== 'in_progress' || attempt.activeSessionId !== sessionId) return;
      const s = attempt.sessions.find((x) => x.sessionId === sessionId);
      if (s && !s.endedAt) { s.endedAt = new Date(); s.endReason = 'disconnected'; }
      attempt.counters.disconnects += 1;
      await attempt.save();
      await logEvent(attempt, 'disconnected', { graceSeconds: GRACE_MS / 1000 }, { sessionId });
      const exam = await Exam.findById(attempt.exam).lean();
      if (exam.settings.resumePolicy === 'not_allowed') await lockAttempt(attempt, 'Left the exam (resume not allowed)');
      else await liveUpdate(attempt, { online: false });
    }, GRACE_MS);
    disconnectTimers.set(attemptId, { timer, sessionId });
  });
});

await mongoose.connect(config.mongoUri);
console.log('MongoDB connected');
startExpiryWatcher();
server.listen(config.port, () => console.log(`Evalix API on :${config.port} (AI monitoring: ${aiEnabled() ? 'Gemini ' + config.geminiModel : 'not configured'})`));
