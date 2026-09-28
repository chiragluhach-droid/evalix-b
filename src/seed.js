// Resets the database and fills it with realistic demo data.
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { Attempt, Event, Exam, Flag, Frame, Notification, User } from './models/index.js';
import { UPLOAD_DIR } from './services/storage.js';

const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pickN = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);
const days = (n) => new Date(Date.now() - n * 864e5);

const FIRST = ['Riya', 'Aditya', 'Karan', 'Ananya', 'Rohan', 'Priya', 'Arjun', 'Sneha', 'Vikram', 'Isha', 'Rahul', 'Neha', 'Aman', 'Pooja', 'Siddharth', 'Kavya', 'Nikhil', 'Meera', 'Harsh', 'Tanvi', 'Yash', 'Diya', 'Varun', 'Aisha', 'Kunal', 'Simran', 'Dev', 'Nisha', 'Manav', 'Ira'];
const LAST = ['Sharma', 'Verma', 'Singh', 'Gupta', 'Mehta', 'Kapoor', 'Malhotra', 'Jain', 'Agarwal', 'Bansal', 'Chopra', 'Reddy', 'Nair', 'Iyer', 'Das', 'Yadav', 'Joshi', 'Arora', 'Bhatia', 'Khanna'];

const Q = (text, options, correctIndex, topic, marks = 1, code, explanation) => ({ text, options, correctIndex, topic, marks, code, explanation });

const BANK = {
  dsa: [
    Q('What is the time complexity of binary search on a sorted array?', ['O(n)', 'O(log n)', 'O(n log n)', 'O(1)'], 1, 'Searching', 2, null, 'The search space halves every step.'),
    Q('What is the output of the following code?', ['8', '11', '9', '12'], 1, 'Loops', 2, 'int a = 5;\nfor (int i = 1; i <= 3; i++) {\n  a = a + i;\n}\ncout << a;', '5 + 1 + 2 + 3 = 11'),
    Q('Which data structure uses LIFO order?', ['Queue', 'Stack', 'Heap', 'Graph'], 1, 'Stacks & Queues'),
    Q('Worst-case time complexity of quicksort?', ['O(n log n)', 'O(n)', 'O(n²)', 'O(log n)'], 2, 'Sorting', 2),
    Q('Which traversal of a BST gives sorted order?', ['Preorder', 'Inorder', 'Postorder', 'Level order'], 1, 'Trees', 2),
    Q('Which algorithm finds shortest paths with non-negative weights?', ['Kruskal', 'Prim', 'Dijkstra', 'DFS'], 2, 'Graphs', 2),
    Q('A hash table lookup is on average:', ['O(1)', 'O(n)', 'O(log n)', 'O(n²)'], 0, 'Hashing'),
    Q('What does this print?', ['15', '10', '5', 'Error'], 0, 'Basics', 1, 'let a = 5;\nlet b = 10;\nconsole.log(a + b);'),
    Q('Which is NOT a stable sorting algorithm by default?', ['Merge sort', 'Insertion sort', 'Heap sort', 'Bubble sort'], 2, 'Sorting', 2),
    Q('BFS on a graph uses which structure?', ['Stack', 'Queue', 'Priority queue', 'Set'], 1, 'Graphs'),
  ],
  math: [
    Q('What is the derivative of x²?', ['x', '2x', 'x²', '2'], 1, 'Calculus'),
    Q('∫ 2x dx = ?', ['x² + C', '2x² + C', 'x + C', '2 + C'], 0, 'Calculus'),
    Q('Determinant of [[1,2],[3,4]]?', ['-2', '2', '10', '-10'], 0, 'Matrices', 2),
    Q('If P(A) = 0.3, P(not A) = ?', ['0.3', '0.7', '1.3', '0'], 1, 'Probability'),
    Q('Solve: 2x + 6 = 14', ['3', '4', '5', '8'], 1, 'Algebra'),
    Q('The sum of angles in a triangle is:', ['90°', '180°', '270°', '360°'], 1, 'Geometry'),
    Q('log₁₀(1000) = ?', ['2', '3', '10', '100'], 1, 'Algebra'),
    Q('Rank of the 3×3 identity matrix?', ['1', '2', '3', '0'], 2, 'Matrices', 2),
  ],
  apt: [
    Q('A train covers 120 km in 2 hours. Its speed is:', ['50 km/h', '60 km/h', '70 km/h', '80 km/h'], 1, 'Speed & Distance'),
    Q('Next number: 2, 6, 12, 20, ?', ['28', '30', '32', '26'], 1, 'Series'),
    Q('20% of 250 is:', ['25', '40', '50', '60'], 2, 'Percentages'),
    Q('If 5 workers finish a job in 12 days, 10 workers take:', ['24 days', '6 days', '10 days', '8 days'], 1, 'Time & Work'),
    Q('Odd one out: Apple, Mango, Carrot, Banana', ['Apple', 'Mango', 'Carrot', 'Banana'], 2, 'Reasoning'),
    Q('Simple interest on ₹1000 at 10% for 2 years:', ['₹100', '₹200', '₹210', '₹150'], 1, 'Interest'),
    Q('Ratio 3:5, total 64. Larger part?', ['24', '40', '36', '30'], 1, 'Ratios'),
    Q('Find the missing letter: A, C, F, J, ?', ['M', 'N', 'O', 'P'], 2, 'Series'),
  ],
  os: [
    Q('Which scheduling algorithm can cause starvation?', ['Round robin', 'FCFS', 'Priority scheduling', 'None'], 2, 'Scheduling', 2),
    Q('A deadlock requires all of these EXCEPT:', ['Mutual exclusion', 'Hold and wait', 'Preemption', 'Circular wait'], 2, 'Deadlocks', 2),
    Q('Page replacement algorithm with Belady’s anomaly:', ['LRU', 'FIFO', 'Optimal', 'LFU'], 1, 'Memory'),
    Q('Which is a non-preemptive algorithm?', ['Round robin', 'SRTF', 'FCFS', 'Multilevel queue'], 2, 'Scheduling'),
    Q('Thrashing happens when:', ['CPU is idle', 'Too much paging', 'Disk is full', 'Cache hits are high'], 1, 'Memory'),
    Q('A semaphore is used for:', ['Memory allocation', 'Process synchronization', 'File storage', 'Networking'], 1, 'Synchronization'),
  ],
};

const DEFAULT_SETTINGS = { fullscreenRequired: true, maxTabSwitches: 5, autoSubmitOnLimit: false, blockCopyPaste: true, shuffleQuestions: true,
  negativeMarking: 0, aiProctoring: true, captureIntervalSec: 30, aiMinSeverity: 'medium', resumePolicy: 'allowed', maxResumes: 3, blockNewDeviceResume: false };

function placeholder(label, color) {
  const file = path.join(UPLOAD_DIR, `demo-${label.replace(/\W+/g, '-').toLowerCase()}.svg`);
  fs.writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#1e1b4b"/>
<circle cx="320" cy="200" r="80" fill="#6366f1" opacity=".5"/><rect x="220" y="290" width="200" height="140" rx="60" fill="#6366f1" opacity=".5"/>
<rect x="0" y="420" width="640" height="60" fill="${color}"/><text x="320" y="458" font-family="sans-serif" font-size="26" fill="#fff" text-anchor="middle">DEMO: ${label}</text></svg>`);
  return file;
}

await mongoose.connect(config.mongoUri);
await mongoose.connection.db.dropDatabase();
await Promise.all([User, Exam, Attempt, Event, Frame, Flag, Notification].map((m) => m.syncIndexes()));
const hash = await bcrypt.hash('password123', 10);

const admin = await User.create({ name: 'Platform Admin', email: 'admin@evalix.com', password: await bcrypt.hash('admin123', 10), role: 'admin' });
const [t1, t2] = await User.insertMany([
  { name: 'Dr. Neha Kapoor', email: 'teacher@evalix.com', password: hash, role: 'teacher', department: 'Computer Science' },
  { name: 'Prof. Rajesh Iyer', email: 'rajesh@evalix.com', password: hash, role: 'teacher', department: 'Mathematics' },
]);
const studentDocs = [{ name: 'Chirag Luhach', email: 'student@evalix.com', rollNo: 'CSE2025001', password: hash, role: 'student', department: 'CSE' }];
for (let i = 2; i <= 250; i++) {
  const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
  studentDocs.push({ name, email: `student${i}@evalix.com`, rollNo: `CSE2025${String(i).padStart(3, '0')}`, password: hash, role: 'student', department: 'CSE' });
}
const students = await User.insertMany(studentDocs);
const demoStudent = students[0];

const exams = await Exam.insertMany([
  { title: 'Mid Sem Exam – DS & Algo', subject: 'Data Structures', createdBy: t1._id, durationMin: 90, status: 'closed', questions: BANK.dsa, settings: { ...DEFAULT_SETTINGS, negativeMarking: 0.25 }, startAt: days(12), endAt: days(11.9), createdAt: days(14) },
  { title: 'DSA Test', subject: 'Data Structures', createdBy: t1._id, durationMin: 45, status: 'closed', questions: BANK.dsa.slice(0, 8), settings: DEFAULT_SETTINGS, startAt: days(8), endAt: days(7.9), createdAt: days(9) },
  { title: 'Math Quiz', subject: 'Mathematics', createdBy: t2._id, durationMin: 30, status: 'closed', questions: BANK.math, settings: { ...DEFAULT_SETTINGS, aiProctoring: false }, startAt: days(5), endAt: days(4.9), createdAt: days(6) },
  { title: 'Aptitude Test', subject: 'Aptitude', createdBy: t1._id, durationMin: 40, status: 'closed', questions: BANK.apt, settings: DEFAULT_SETTINGS, startAt: days(2), endAt: days(1.9), createdAt: days(3) },
  { title: 'Operating Systems Quiz', subject: 'Operating Systems', description: 'Live demo exam — open now. Camera monitoring on, resume allowed up to 3 times.', createdBy: t1._id, durationMin: 20, status: 'published', questions: BANK.os, settings: { ...DEFAULT_SETTINGS, captureIntervalSec: 20 }, createdAt: days(0.5) },
  { title: 'Computer Networks – Unit Test', subject: 'Networks', createdBy: t1._id, durationMin: 30, status: 'draft', questions: [], settings: DEFAULT_SETTINGS, createdAt: days(0.2) },
]);

// Past attempts with varied performance, violations, resumes and AI flags.
const skill = Object.fromEntries(students.map((s) => [String(s._id), Math.random() * 0.55 + 0.4]));
const attempts = [];
const events = [];
const flags = [];
const imgs = { Phone: placeholder('Phone detected', '#dc2626'), 'Multiple people': placeholder('Multiple people', '#dc2626'), 'No face': placeholder('No face', '#d97706'), 'Books/notes': placeholder('Books or notes', '#d97706') };
const flagKinds = Object.keys(imgs);

for (const exam of exams.slice(0, 4)) {
  const takers = pickN(students, rand(90, 160));
  if (!takers.includes(demoStudent)) takers.push(demoStudent);
  const total = exam.questions.reduce((s, q) => s + q.marks, 0);
  for (const st of takers) {
    const startedAt = new Date(exam.startAt.getTime() + rand(0, 10) * 60000);
    const answers = {};
    let score = 0; let correctCount = 0;
    exam.questions.forEach((q, i) => {
      if (Math.random() < 0.08) return;
      const right = Math.random() < skill[String(st._id)];
      answers[i] = right ? q.correctIndex : (q.correctIndex + rand(1, q.options.length - 1)) % q.options.length;
      if (right) { score += q.marks; correctCount++; } else score -= exam.settings.negativeMarking;
    });
    const cheaty = Math.random() < 0.12;
    const counters = { tabSwitches: cheaty ? rand(3, 9) : rand(0, 1), fullscreenExits: cheaty ? rand(1, 4) : rand(0, 1), copyPaste: cheaty ? rand(0, 3) : 0, disconnects: Math.random() < 0.08 ? 1 : 0, aiFlags: 0 };
    const resumed = counters.disconnects > 0 || Math.random() < 0.05;
    const deviceChanged = resumed && Math.random() < 0.35;
    const dev = `dev-${st._id}`;
    const sessions = [{ sessionId: `s1-${st._id}`, deviceId: dev, browser: 'Chrome 140', os: 'Windows 11', ip: `10.0.${rand(1, 20)}.${rand(2, 250)}`, startedAt, lastSeenAt: new Date(startedAt.getTime() + 15 * 60000), endedAt: resumed ? new Date(startedAt.getTime() + 15 * 60000) : undefined, endReason: resumed ? 'disconnected' : 'submitted' }];
    if (resumed) sessions.push({ sessionId: `s2-${st._id}`, deviceId: deviceChanged ? `dev-phone-${st._id}` : dev, browser: deviceChanged ? 'Mobile Safari 18' : 'Chrome 140', os: deviceChanged ? 'iOS 18' : 'Windows 11', ip: deviceChanged ? `49.36.${rand(1, 200)}.${rand(2, 250)}` : sessions[0].ip, startedAt: new Date(startedAt.getTime() + 17 * 60000), lastSeenAt: new Date(startedAt.getTime() + 30 * 60000), isResume: true, deviceChanged, browserChanged: deviceChanged, ipChanged: deviceChanged, awaySeconds: 120, endReason: 'submitted' });
    const submittedAt = new Date(startedAt.getTime() + rand(12, exam.durationMin) * 60000);
    const a = {
      _id: new mongoose.Types.ObjectId(), exam: exam._id, student: st._id, status: 'submitted', questionOrder: exam.questions.map((_q, i) => i), answers,
      startedAt, endsAt: new Date(startedAt.getTime() + exam.durationMin * 60000), submittedAt, submitReason: Math.random() < 0.1 ? 'timeout' : 'manual',
      score: Math.max(0, Math.round(score * 100) / 100), totalMarks: total, correctCount, sessions, activeSessionId: sessions.at(-1).sessionId,
      resumeCount: resumed ? 1 : 0, deviceChangedEver: deviceChanged, counters,
    };
    const ev = (type, minute, meta = {}) => events.push({ attempt: a._id, exam: exam._id, student: st._id, type, meta, at: new Date(startedAt.getTime() + minute * 60000), sessionId: sessions[0].sessionId });
    ev('instructions_accepted', 0); ev('exam_started', 0, { browser: 'Chrome 140', os: 'Windows 11' });
    for (let k = 0; k < counters.tabSwitches; k++) { const m = rand(2, 25); ev('tab_hidden', m); ev('tab_visible', m + 0.3, { awaySeconds: rand(3, 40) }); }
    for (let k = 0; k < counters.fullscreenExits; k++) ev('fullscreen_exit', rand(2, 25));
    for (let k = 0; k < counters.copyPaste; k++) ev('paste_attempt', rand(2, 25));
    if (resumed) { ev('disconnected', 15.5); ev('resumed', 17, { resumeNo: 1, awaySeconds: 120, deviceChanged, browserChanged: deviceChanged, ipChanged: deviceChanged }); if (deviceChanged) ev('device_changed', 17); }
    if (exam.settings.aiProctoring && cheaty && Math.random() < 0.6) {
      const kind = flagKinds[rand(0, flagKinds.length - 1)];
      const status = ['pending', 'confirmed', 'dismissed'][rand(0, 2)];
      flags.push({ attempt: a._id, exam: exam._id, student: st._id, teacher: exam.createdBy, imagePath: imgs[kind], types: [kind], severity: kind === 'Phone' || kind === 'Multiple people' ? 'high' : 'medium', confidence: 0.8, reason: `Demo data: ${kind.toLowerCase()} visible in webcam frame.`, status, demo: true, createdAt: new Date(startedAt.getTime() + rand(5, 25) * 60000) });
      a.counters.aiFlags = 1;
      ev('ai_flag', rand(5, 25), { types: [kind], severity: 'high' });
    }
    ev('submitted', (submittedAt - startedAt) / 60000, { reason: a.submitReason, score: a.score });
    attempts.push(a);
  }
}
await Attempt.insertMany(attempts);
await Event.insertMany(events);
await Flag.insertMany(flags);
await Notification.insertMany([
  { user: t1._id, title: 'Welcome to Evalix', body: 'The Operating Systems Quiz is live. Open it to watch students in real time.', link: `/teacher/exams/${exams[4]._id}`, kind: 'info' },
  { user: demoStudent._id, title: 'New exam published', body: 'Operating Systems Quiz is open now.', link: '/student', kind: 'info' },
]);
console.log(`Seeded: ${students.length} students, ${exams.length} exams, ${attempts.length} attempts, ${events.length} events, ${flags.length} demo flags.`);
console.log('Logins → admin@evalix.com / admin123 · teacher@evalix.com / password123 · student@evalix.com (or CSE2025001) / password123');
await mongoose.disconnect();
