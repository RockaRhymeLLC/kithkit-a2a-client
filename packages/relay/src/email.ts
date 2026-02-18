/**
 * Email verification — 6-digit codes with SHA-256 hashing.
 *
 * Codes sent via injectable email sender (Resend in prod, mock in tests).
 * Codes expire after 10 minutes, max 3 confirmation attempts.
 */

import { createHash, randomInt } from 'node:crypto';
import type Database from 'better-sqlite3';

/** How long a verification code is valid (10 minutes). */
const CODE_EXPIRY_MS = 10 * 60 * 1000;

/** Max wrong-code attempts before lockout. */
const MAX_ATTEMPTS = 3;

/** Max verification sends per IP per hour. */
const MAX_SENDS_PER_HOUR = 3;

/** Email sender function type — injectable for testing. */
export type EmailSender = (to: string, subject: string, body: string) => Promise<boolean>;

/**
 * Generate a 6-digit verification code.
 */
export function generateCode(): string {
  return String(randomInt(100000, 999999));
}

/**
 * SHA-256 hash a code for storage.
 */
export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Send a verification code to an email address.
 * Stores the hashed code in the database and sends via the email sender.
 *
 * @param db - Database instance
 * @param agentName - Agent requesting verification
 * @param email - Email to verify
 * @param sender - Email sender function
 * @param ip - Requester IP for rate limiting
 * @param now - Current time in ms (injectable for testing)
 */
export async function sendVerificationCode(
  db: Database.Database,
  agentName: string,
  email: string,
  sender: EmailSender,
  ip: string,
  now: number = Date.now(),
): Promise<{ ok: boolean; error?: string; status?: number; retryAfter?: number; rateLimit?: number; rateLimitRemaining?: number; rateLimitReset?: string }> {
  // Rate limit: max 3 sends per hour per IP
  const rateLimitKey = `verify-send:${ip}`;
  const windowStart = new Date(now - 60 * 60 * 1000).toISOString();

  const rateEntry = db.prepare(
    'SELECT count, window_start FROM rate_limits WHERE key = ?'
  ).get(rateLimitKey) as { count: number; window_start: string } | undefined;

  if (rateEntry) {
    const windowMs = new Date(rateEntry.window_start).getTime();
    if (now - windowMs < 60 * 60 * 1000 && rateEntry.count >= MAX_SENDS_PER_HOUR) {
      const resetMs = windowMs + 60 * 60 * 1000;
      const retryAfter = Math.ceil((resetMs - now) / 1000);
      return {
        ok: false, error: 'Rate limit exceeded', status: 429,
        retryAfter,
        rateLimit: MAX_SENDS_PER_HOUR,
        rateLimitRemaining: 0,
        rateLimitReset: new Date(resetMs).toISOString(),
      };
    }
    if (now - windowMs >= 60 * 60 * 1000) {
      // Reset window
      db.prepare('UPDATE rate_limits SET count = 1, window_start = ? WHERE key = ?')
        .run(new Date(now).toISOString(), rateLimitKey);
    } else {
      db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?')
        .run(rateLimitKey);
    }
  } else {
    db.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)')
      .run(rateLimitKey, new Date(now).toISOString());
  }

  // Generate code
  const code = generateCode();
  const codeHash = hashCode(code);
  const expiresAt = new Date(now + CODE_EXPIRY_MS).toISOString();

  // Upsert verification entry (overwrites any existing code for this agent)
  db.prepare(`
    INSERT INTO email_verifications (agent_name, email, code_hash, attempts, expires_at, verified)
    VALUES (?, ?, ?, 0, ?, 0)
    ON CONFLICT(agent_name) DO UPDATE SET
      email = excluded.email,
      code_hash = excluded.code_hash,
      attempts = 0,
      expires_at = excluded.expires_at,
      verified = 0
  `).run(agentName, email, codeHash, expiresAt);

  // Send email
  const sent = await sender(
    email,
    'CC4Me Network — Verification Code',
    `Your verification code is: ${code}\n\nThis code expires in 10 minutes.`,
  );

  if (!sent) {
    return { ok: false, error: 'Failed to send email', status: 500 };
  }

  return { ok: true };
}

/**
 * Confirm a verification code.
 *
 * @param db - Database instance
 * @param agentName - Agent confirming
 * @param code - The 6-digit code the user received
 * @param now - Current time in ms (injectable for testing)
 */
export function confirmVerificationCode(
  db: Database.Database,
  agentName: string,
  code: string,
  now: number = Date.now(),
): { ok: boolean; error?: string; status?: number } {
  const entry = db.prepare(
    'SELECT * FROM email_verifications WHERE agent_name = ?'
  ).get(agentName) as {
    agent_name: string;
    email: string;
    code_hash: string;
    attempts: number;
    expires_at: string;
    verified: number;
  } | undefined;

  if (!entry) {
    return { ok: false, error: 'No verification pending', status: 400 };
  }

  // Already verified
  if (entry.verified) {
    return { ok: true };
  }

  // Check expiry
  const expiresMs = new Date(entry.expires_at).getTime();
  if (now > expiresMs) {
    return { ok: false, error: 'Code expired', status: 400 };
  }

  // Check attempts
  if (entry.attempts >= MAX_ATTEMPTS) {
    return { ok: false, error: 'Max attempts exceeded', status: 400 };
  }

  // Increment attempts
  db.prepare(
    'UPDATE email_verifications SET attempts = attempts + 1 WHERE agent_name = ?'
  ).run(agentName);

  // Verify code
  const providedHash = hashCode(code);
  if (providedHash !== entry.code_hash) {
    // Check if we just hit the max
    if (entry.attempts + 1 >= MAX_ATTEMPTS) {
      return { ok: false, error: 'Max attempts exceeded', status: 400 };
    }
    return { ok: false, error: 'Invalid code', status: 400 };
  }

  // Mark verified
  db.prepare(
    'UPDATE email_verifications SET verified = 1 WHERE agent_name = ?'
  ).run(agentName);

  return { ok: true };
}
