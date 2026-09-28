import fs from 'node:fs';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { Notification, User } from '../models/index.js';
import { emitTo } from './realtime.js';

const mailer = config.smtp.host
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : null;

export async function notify(userId, { title, body, link, kind = 'info', imagePath }) {
  const n = await Notification.create({ user: userId, title, body, link, kind });
  emitTo(`user:${userId}`, 'notification', n);
  if (mailer && kind !== 'info') {
    const user = await User.findById(userId).lean();
    if (user?.email) {
      mailer
        .sendMail({
          from: config.smtp.from || config.smtp.user,
          to: user.email,
          subject: `[Evalix] ${title}`,
          text: `${body}\n\nOpen: ${config.clientUrl}${link || ''}`,
          attachments: imagePath && fs.existsSync(imagePath) ? [{ filename: 'evidence.jpg', path: imagePath }] : [],
        })
        .catch((e) => console.warn('Email failed:', e.message));
    }
  }
  return n;
}
