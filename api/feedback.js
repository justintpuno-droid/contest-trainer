// api/feedback.js — Vercel serverless function
// Sends feedback submitted from the trainer page to justintpuno@gmail.com
// via Resend. Mirrors the equivalent endpoint in the Lemma landing page repo.

import { Resend } from 'resend';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const { message } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'RESEND_API_KEY not configured' });
  }

  try {
    const resend = new Resend(apiKey);
    await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: 'justintpuno@gmail.com',
      subject: 'New Lemma trainer feedback',
      html: '<p>' + message.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>'
    });
    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(502).json({ error: 'Failed to send' });
  }
}