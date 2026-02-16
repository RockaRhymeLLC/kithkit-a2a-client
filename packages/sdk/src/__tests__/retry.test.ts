/**
 * Tests for retry queue (t-053).
 *
 * t-053: Retry queue backoff timing, expiry, bounded size.
 *
 * Uses node:test mock.timers to control time without real waits.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RetryQueue } from '../retry.js';

/** Flush microtasks so async process() completes after timer tick. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('t-053: Retry queue backoff timing, expiry, bounded size', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  // Step 1: Create a RetryQueue with max size 3
  it('step 1: creates queue with correct max size', () => {
    const queue = new RetryQueue(3);
    assert.equal(queue.size, 0, 'Fresh queue should be empty');
  });

  // Step 2: Enqueue message "msg-1"
  it('step 2: enqueue returns true and fires pending event', async () => {
    const queue = new RetryQueue(3);
    const events: Array<{ messageId: string; status: string }> = [];
    queue.on('delivery-status', (evt) => events.push(evt));

    const result = queue.enqueue('msg-1', 'bob', { text: 'hello' });
    assert.equal(result, true, 'Enqueue should return true');
    assert.equal(queue.size, 1, 'Queue size should be 1');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.messageId, 'msg-1');
    assert.equal(events[0]!.status, 'pending');

    queue.stop();
  });

  // Steps 3-6: Mock send that always fails, verify retry timing and failure
  it('steps 3-6: retries at 10s, 30s, 90s then fails', async () => {
    const queue = new RetryQueue(3);
    const events: Array<{ messageId: string; status: string; attempts: number }> = [];
    queue.on('delivery-status', (evt) => events.push(evt));

    // Step 3: register mock send that always fails
    const sendFn = mock.fn(async () => false);
    queue.setSendFn(sendFn);

    queue.enqueue('msg-1', 'bob', { text: 'hello' });
    // Events so far: [pending]
    assert.equal(events.length, 1);

    // Step 4: Advance 10s — first retry interval
    // The internal timer fires every 1s, process checks nextRetryAt
    mock.timers.tick(10_000);
    await flush();

    // Should have: pending → sending → (back to pending after fail)
    const sendingEvents = events.filter((e) => e.status === 'sending');
    assert.equal(sendingEvents.length, 1, 'Should have 1 sending event after 10s');
    assert.equal(sendFn.mock.callCount(), 1, 'Send should have been called once');

    // Step 5: Advance another 30s — second retry
    mock.timers.tick(30_000);
    await flush();

    assert.equal(sendFn.mock.callCount(), 2, 'Send should have been called twice after 40s');

    // Step 6: Advance another 90s — third retry, then fails
    mock.timers.tick(90_000);
    await flush();

    assert.equal(sendFn.mock.callCount(), 3, 'Send should have been called 3 times');
    const failEvents = events.filter((e) => e.status === 'failed');
    assert.equal(failEvents.length, 1, 'Should have 1 failed event after 3 retries');
    assert.equal(queue.size, 0, 'Queue should be empty after failure');

    queue.stop();
  });

  // Steps 7-8: Queue bounds
  it('steps 7-8: queue bounded at max size', () => {
    const queue = new RetryQueue(3);

    // Step 7: Fill to max
    assert.equal(queue.enqueue('a', 'bob', {}), true);
    assert.equal(queue.enqueue('b', 'bob', {}), true);
    assert.equal(queue.enqueue('c', 'bob', {}), true);
    assert.equal(queue.size, 3);

    // Step 8: 4th message rejected
    assert.equal(queue.enqueue('d', 'bob', {}), false, 'Should reject when full');
    assert.equal(queue.size, 3, 'Size should still be 3');

    queue.stop();
  });

  // Step 9: Successful retry emits 'delivered'
  it('step 9: successful retry emits delivered', async () => {
    const queue = new RetryQueue(3);
    const events: Array<{ messageId: string; status: string }> = [];
    queue.on('delivery-status', (evt) => events.push(evt));

    // Send fails first time, succeeds second time
    let callCount = 0;
    queue.setSendFn(async () => {
      callCount++;
      return callCount >= 2; // succeed on 2nd attempt
    });

    queue.enqueue('msg-retry', 'bob', { text: 'retry me' });

    // First retry at 10s — fails
    mock.timers.tick(10_000);
    await flush();
    assert.equal(callCount, 1);

    // Second retry at 10s + 30s = 40s — succeeds
    mock.timers.tick(30_000);
    await flush();
    assert.equal(callCount, 2);

    const delivered = events.filter((e) => e.status === 'delivered');
    assert.equal(delivered.length, 1, 'Should have 1 delivered event');
    assert.equal(delivered[0]!.messageId, 'msg-retry');
    assert.equal(queue.size, 0, 'Queue should be empty after delivery');

    queue.stop();
  });

  // Step 10: Message expires after 1 hour
  it('step 10: message expires after 1 hour', async () => {
    const queue = new RetryQueue(3);
    const events: Array<{ messageId: string; status: string }> = [];
    queue.on('delivery-status', (evt) => events.push(evt));

    // Send that never succeeds
    queue.setSendFn(async () => false);
    queue.enqueue('msg-expire', 'bob', { text: 'expire me' });

    // Fast-forward past all retries but before 1 hour
    // After 3 failed retries (10s + 30s + 90s = 130s), message should already be 'failed'
    // But for expiry test, we want to test messages that haven't exhausted retries yet
    // So let's use a new queue with a send function that's never called
    // (message sits in queue with pending retries, but we jump past 1 hour)
    queue.stop();

    const queue2 = new RetryQueue(3);
    const events2: Array<{ messageId: string; status: string }> = [];
    queue2.on('delivery-status', (evt) => events2.push(evt));

    // Don't set sendFn — process() will treat send as always-fail
    // but we'll jump past 1 hour before any retry fires
    queue2.enqueue('msg-old', 'bob', { text: 'old message' });

    // Jump past 1 hour (3600s + a bit)
    mock.timers.tick(3_601_000);
    await flush();

    const expired = events2.filter((e) => e.status === 'expired');
    assert.equal(expired.length, 1, 'Should have 1 expired event');
    assert.equal(expired[0]!.messageId, 'msg-old');
    assert.equal(queue2.size, 0, 'Queue should be empty after expiry');

    queue2.stop();
  });
});

// ================================================================
// Additional retry queue coverage
// ================================================================

describe('Retry queue: timer management', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('stops timer when queue drains', async () => {
    const queue = new RetryQueue(10);
    queue.setSendFn(async () => true); // always succeed

    queue.enqueue('msg-1', 'bob', {});

    // After first retry at 10s, send succeeds, queue empties, timer stops
    mock.timers.tick(10_000);
    await flush();

    assert.equal(queue.size, 0, 'Queue should be empty');
    // Timer should have been cleared (no more processing)
  });

  it('delivery-status events cover all transitions', async () => {
    const queue = new RetryQueue(3);
    const statusHistory: string[] = [];
    queue.on('delivery-status', (evt) => statusHistory.push(evt.status));

    queue.setSendFn(async () => false);
    queue.enqueue('msg-track', 'bob', {});

    // pending (enqueue)
    assert.deepStrictEqual(statusHistory, ['pending']);

    // First retry: sending → pending (after fail)
    mock.timers.tick(10_000);
    await flush();
    assert.ok(statusHistory.includes('sending'), 'Should have sending status');

    // Second retry
    mock.timers.tick(30_000);
    await flush();

    // Third retry → failed
    mock.timers.tick(90_000);
    await flush();
    assert.ok(statusHistory.includes('failed'), 'Should end with failed status');

    queue.stop();
  });

  it('multiple messages processed independently', async () => {
    const queue = new RetryQueue(10);
    const delivered: string[] = [];
    queue.on('delivery-status', (evt) => {
      if (evt.status === 'delivered') delivered.push(evt.messageId);
    });

    // msg-a succeeds on first try, msg-b never succeeds
    queue.setSendFn(async (msg) => msg.messageId === 'msg-a');

    queue.enqueue('msg-a', 'bob', {});
    queue.enqueue('msg-b', 'bob', {});

    mock.timers.tick(10_000);
    await flush();

    assert.ok(delivered.includes('msg-a'), 'msg-a should be delivered');
    assert.ok(!delivered.includes('msg-b'), 'msg-b should not be delivered yet');
    assert.equal(queue.size, 1, 'Only msg-b should remain');

    queue.stop();
  });
});
