/**
 * Local retry queue — exponential backoff for failed message deliveries.
 *
 * Schedule: 10s, 30s, 90s (3 attempts). Messages expire after 1 hour.
 * Queue bounded at configurable max (default: 100 messages).
 */

import { EventEmitter } from 'node:events';
import type { DeliveryStatus } from './types.js';

export interface QueuedMessage {
  messageId: string;
  recipient: string;
  payload: Record<string, unknown>;
  status: DeliveryStatus['status'];
  attempts: number;
  createdAt: number;
  nextRetryAt: number;
  groupId?: string;
}

const DEFAULT_RETRY_DELAYS = [10_000, 30_000, 90_000]; // 10s, 30s, 90s
const DEFAULT_PROCESS_INTERVAL = 1000; // 1s
const MAX_AGE = 60 * 60 * 1000; // 1 hour

export class RetryQueue extends EventEmitter {
  private queue: Map<string, QueuedMessage> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private maxSize: number;
  private retryDelays: number[];
  private processInterval: number;
  private sendFn: ((msg: QueuedMessage) => Promise<boolean>) | null = null;

  constructor(maxSize = 100, retryDelays?: number[], processInterval?: number) {
    super();
    this.maxSize = maxSize;
    this.retryDelays = retryDelays || DEFAULT_RETRY_DELAYS;
    this.processInterval = processInterval || DEFAULT_PROCESS_INTERVAL;
  }

  /** Set the send function that will be called on retry. */
  setSendFn(fn: (msg: QueuedMessage) => Promise<boolean>): void {
    this.sendFn = fn;
  }

  /** Add a message to the retry queue. */
  enqueue(messageId: string, recipient: string, payload: Record<string, unknown>, groupId?: string): boolean {
    if (this.queue.size >= this.maxSize) return false;

    const now = Date.now();
    this.queue.set(messageId, {
      messageId,
      recipient,
      payload,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      nextRetryAt: now + this.retryDelays[0]!,
      groupId,
    });

    this.emitStatus(messageId, 'pending', 0);
    this.ensureTimer();
    return true;
  }

  /** Start processing the queue. */
  start(): void {
    this.ensureTimer();
  }

  /** Stop processing the queue. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get current queue size. */
  get size(): number {
    return this.queue.size;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.process(), this.processInterval);
  }

  private async process(): Promise<void> {
    const now = Date.now();

    for (const [id, msg] of this.queue) {
      // Expire old messages
      if (now - msg.createdAt > MAX_AGE) {
        msg.status = 'expired';
        this.emitStatus(id, 'expired', msg.attempts);
        this.queue.delete(id);
        continue;
      }

      // Skip if not ready for retry
      if (now < msg.nextRetryAt || msg.status === 'sending') continue;

      // Attempt delivery
      msg.status = 'sending';
      msg.attempts++;
      this.emitStatus(id, 'sending', msg.attempts);

      const success = this.sendFn ? await this.sendFn(msg) : false;

      if (success) {
        msg.status = 'delivered';
        this.emitStatus(id, 'delivered', msg.attempts);
        this.queue.delete(id);
      } else if (msg.attempts >= this.retryDelays.length) {
        msg.status = 'failed';
        this.emitStatus(id, 'failed', msg.attempts);
        this.queue.delete(id);
      } else {
        msg.status = 'pending';
        msg.nextRetryAt = now + this.retryDelays[msg.attempts]!;
      }
    }

    // Stop timer if queue is empty
    if (this.queue.size === 0) {
      this.stop();
    }
  }

  private emitStatus(messageId: string, status: DeliveryStatus['status'], attempts: number): void {
    this.emit('delivery-status', { messageId, status, attempts } satisfies DeliveryStatus);
  }
}
