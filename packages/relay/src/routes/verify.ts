/**
 * Email verification routes — send and confirm verification codes.
 *
 * POST /verify/send     — Request verification code (unauthenticated)
 * POST /verify/confirm  — Submit verification code (unauthenticated)
 *
 * These endpoints are unauthenticated because the agent isn't registered yet.
 * Rate limiting is applied per IP address.
 */

import type Database from 'better-sqlite3';
import { sendVerificationCode, confirmVerificationCode, type EmailSender } from '../email.js';

export interface VerifyRouteResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Handle POST /verify/send
 *
 * Body: { agentName: string, email: string }
 * Rate limited to 3 per hour per IP.
 */
export async function handleVerifySend(
  db: Database.Database,
  data: { agentName?: string; email?: string },
  sender: EmailSender,
  ip: string,
): Promise<VerifyRouteResult> {
  if (!data.agentName || typeof data.agentName !== 'string') {
    return { ok: false, status: 400, error: 'agentName is required' };
  }
  if (!data.email || typeof data.email !== 'string') {
    return { ok: false, status: 400, error: 'email is required' };
  }

  // Basic email format check
  if (!data.email.includes('@') || data.email.length > 254) {
    return { ok: false, status: 400, error: 'Invalid email format' };
  }

  return sendVerificationCode(db, data.agentName, data.email, sender, ip);
}

/**
 * Handle POST /verify/confirm
 *
 * Body: { agentName: string, code: string }
 */
export function handleVerifyConfirm(
  db: Database.Database,
  data: { agentName?: string; code?: string },
): VerifyRouteResult {
  if (!data.agentName || typeof data.agentName !== 'string') {
    return { ok: false, status: 400, error: 'agentName is required' };
  }
  if (!data.code || typeof data.code !== 'string') {
    return { ok: false, status: 400, error: 'code is required' };
  }

  // Code must be exactly 6 digits
  if (!/^\d{6}$/.test(data.code)) {
    return { ok: false, status: 400, error: 'Code must be 6 digits' };
  }

  return confirmVerificationCode(db, data.agentName, data.code);
}
