/**
 * Resend email sender — implements EmailSender for verification codes.
 *
 * Uses Resend's REST API directly (no SDK needed).
 * Requires RESEND_API_KEY and optionally RESEND_FROM_ADDRESS env vars.
 */

import type { EmailSender } from './email.js';

const API_KEY = process.env.RESEND_API_KEY || '';
const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || 'CC4Me Network <noreply@bmobot.ai>';

/**
 * Send an email via Resend.
 * Returns true on success, false on failure.
 */
export const resendSender: EmailSender = async (
  to: string,
  subject: string,
  body: string,
): Promise<boolean> => {
  if (!API_KEY) {
    console.error('Resend send failed: RESEND_API_KEY not set');
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [to],
        subject,
        text: body,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Resend send failed (${res.status}):`, err);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Resend send failed:', err instanceof Error ? err.message : err);
    return false;
  }
};
