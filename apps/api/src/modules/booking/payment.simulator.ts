import { randomInt } from 'node:crypto';
import { PAYMENT_SIM_LATENCY_MAX_MS, PAYMENT_SIM_LATENCY_MIN_MS, type SimulatedOutcome } from '@flight/shared';
import { countPaymentCall } from '../../platform/testSupport.js';

export interface PaymentResult {
  approved: boolean;
  /** `SIMPAY-` + 8 random characters. Present for approved payments. */
  reference: string;
}

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomReference(): string {
  let suffix = '';
  for (let i = 0; i < 8; i += 1) suffix += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return `SIMPAY-${suffix}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Simulated payment: waits 300-800 ms (so concurrency tests are realistic), then approves unless the
 * request asked for a decline. Runs at most once per idempotency key, because replays return
 * before Phase B.
 *
 * With a real provider the idempotency key would be forwarded to the provider, and a failure after
 * capture (e.g. the confirm transaction failing) would need a refund step. Both are out of scope.
 */
export async function simulatePayment(outcome: SimulatedOutcome): Promise<PaymentResult> {
  countPaymentCall();
  await sleep(randomInt(PAYMENT_SIM_LATENCY_MIN_MS, PAYMENT_SIM_LATENCY_MAX_MS + 1));
  return { approved: outcome !== 'DECLINED', reference: randomReference() };
}
