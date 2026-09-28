/**
 * Money is always DECIMAL in MySQL and a string in JSON (e.g. "5499.00"). Arithmetic is done in
 * integer minor units (paise) so floats never touch an amount.
 */

const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/;

/** "5499.00" | "5499" | "5499.5" -> 549900 | 549900 | 549950. Throws on anything else. */
export function toMinorUnits(amount: string): number {
  if (!AMOUNT.test(amount)) throw new Error(`Invalid money amount: ${JSON.stringify(amount)}`);
  const [whole = '0', fraction = ''] = amount.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** 549900 -> "5499.00". */
export function fromMinorUnits(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error(`Invalid minor-unit amount: ${minor}`);
  const whole = Math.floor(minor / 100);
  const fraction = String(minor % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}

export function sumMoney(amounts: readonly string[]): string {
  return fromMinorUnits(amounts.reduce((total, amount) => total + toMinorUnits(amount), 0));
}
