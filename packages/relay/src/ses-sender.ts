/**
 * AWS SES email sender — implements EmailSender for verification codes.
 *
 * Uses @aws-sdk/client-ses. Credentials come from environment variables
 * (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) or instance metadata.
 */

import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import type { EmailSender } from './email.js';

const FROM_ADDRESS = process.env.SES_FROM_ADDRESS || 'noreply@bmobot.ai';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

let client: SESClient | null = null;

function getClient(): SESClient {
  if (!client) {
    client = new SESClient({ region: AWS_REGION });
  }
  return client;
}

/**
 * Send an email via AWS SES.
 * Returns true on success, false on failure.
 */
export const sesSender: EmailSender = async (
  to: string,
  subject: string,
  body: string,
): Promise<boolean> => {
  try {
    const ses = getClient();
    await ses.send(new SendEmailCommand({
      Source: FROM_ADDRESS,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: body, Charset: 'UTF-8' },
        },
      },
    }));
    return true;
  } catch (err) {
    console.error('SES send failed:', err instanceof Error ? err.message : err);
    return false;
  }
};
