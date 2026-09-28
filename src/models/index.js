import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;
const id = (ref) => ({ type: Types.ObjectId, ref });

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    rollNo: { type: String, trim: true, sparse: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['admin', 'teacher', 'student'], required: true },
    department: String,
  },
  { timestamps: true }
);
userSchema.set('toJSON', { transform: (_d, r) => { delete r.password; return r; } });

const questionSchema = new Schema({
  text: { type: String, required: true },
  code: String,
  options: { type: [String], validate: (v) => v.length >= 2 },
  correctIndex: { type: Number, required: true },
  marks: { type: Number, default: 1 },
  topic: { type: String, default: 'General' },
  explanation: String,
});

const examSchema = new Schema(
  {
    title: { type: String, required: true },
    description: String,
    subject: String,
    createdBy: { ...id('User'), required: true },
    durationMin: { type: Number, default: 30 },
    startAt: Date,
    endAt: Date,
    status: { type: String, enum: ['draft', 'published', 'closed'], default: 'draft' },
    resultsPublished: { type: Boolean, default: true },
    questions: [questionSchema],
    settings: {
      fullscreenRequired: { type: Boolean, default: true },
      maxTabSwitches: { type: Number, default: 5 },
      autoSubmitOnLimit: { type: Boolean, default: false },
      blockCopyPaste: { type: Boolean, default: true },
      shuffleQuestions: { type: Boolean, default: false },
      negativeMarking: { type: Number, default: 0 },
      aiProctoring: { type: Boolean, default: true },
      captureIntervalSec: { type: Number, default: 30 },
      aiMinSeverity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
      resumePolicy: { type: String, enum: ['not_allowed', 'allowed'], default: 'allowed' },
      maxResumes: { type: Number, default: 3 },
      blockNewDeviceResume: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);
examSchema.virtual('totalMarks').get(function () {
  return (this.questions || []).reduce((s, q) => s + (q.marks || 0), 0);
});
examSchema.set('toJSON', { virtuals: true });

const sessionSchema = new Schema(
  {
    sessionId: String,
    deviceId: String,
    fingerprint: String,
    browser: String,
    os: String,
    ip: String,
    screen: String,
    timezone: String,
    startedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    endedAt: Date,
    endReason: String,
    isResume: { type: Boolean, default: false },
    deviceChanged: { type: Boolean, default: false },
    browserChanged: { type: Boolean, default: false },
    ipChanged: { type: Boolean, default: false },
    awaySeconds: Number,
  },
  { _id: false }
);

const attemptSchema = new Schema(
  {
    exam: { ...id('Exam'), required: true },
    student: { ...id('User'), required: true },
    status: { type: String, enum: ['in_progress', 'locked', 'submitted'], default: 'in_progress' },
    questionOrder: [Number],
    answers: { type: Map, of: Number, default: {} },
    marked: [Number],
    currentIndex: { type: Number, default: 0 },
    startedAt: { type: Date, default: Date.now },
    endsAt: Date,
    submittedAt: Date,
    submitReason: { type: String, enum: ['manual', 'timeout', 'violation', 'teacher'] },
    score: Number,
    totalMarks: Number,
    correctCount: Number,
    referencePhoto: String,
    sessions: [sessionSchema],
    activeSessionId: String,
    resumeCount: { type: Number, default: 0 },
    deviceChangedEver: { type: Boolean, default: false },
    counters: {
      tabSwitches: { type: Number, default: 0 },
      fullscreenExits: { type: Number, default: 0 },
      copyPaste: { type: Number, default: 0 },
      disconnects: { type: Number, default: 0 },
      aiFlags: { type: Number, default: 0 },
    },
    lastFrameAt: Date,
    lockedReason: String,
  },
  { timestamps: true }
);
attemptSchema.index({ exam: 1, student: 1 }, { unique: true });

const eventSchema = new Schema({
  attempt: { ...id('Attempt'), index: true },
  exam: { ...id('Exam'), index: true },
  student: id('User'),
  sessionId: String,
  type: { type: String, required: true },
  questionIndex: Number,
  meta: Schema.Types.Mixed,
  at: { type: Date, default: Date.now },
});

const frameSchema = new Schema({
  attempt: { ...id('Attempt'), index: true },
  exam: id('Exam'),
  student: id('User'),
  sessionId: String,
  trigger: String,
  path: String,
  status: { type: String, enum: ['pending', 'clean', 'flagged', 'unanalyzed', 'skipped'], default: 'pending' },
  analysis: Schema.Types.Mixed,
  error: String,
  at: { type: Date, default: Date.now },
});

const flagSchema = new Schema(
  {
    attempt: { ...id('Attempt'), index: true },
    exam: { ...id('Exam'), index: true },
    student: id('User'),
    teacher: { ...id('User'), index: true },
    frame: id('Frame'),
    imagePath: String,
    types: [String],
    severity: String,
    confidence: Number,
    reason: String,
    status: { type: String, enum: ['pending', 'confirmed', 'dismissed'], default: 'pending' },
    note: String,
    occurrences: { type: Number, default: 1 },
    demo: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const notificationSchema = new Schema(
  {
    user: { ...id('User'), index: true },
    title: String,
    body: String,
    link: String,
    kind: { type: String, default: 'info' },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const User = model('User', userSchema);
export const Exam = model('Exam', examSchema);
export const Attempt = model('Attempt', attemptSchema);
export const Event = model('Event', eventSchema);
export const Frame = model('Frame', frameSchema);
export const Flag = model('Flag', flagSchema);
export const Notification = model('Notification', notificationSchema);
