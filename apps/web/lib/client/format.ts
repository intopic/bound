/** "12.5" with 6 decimals → 12500000n. Returns null for anything that is not a plain positive decimal. */
export function parseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/**
 * 12500000n with 6 decimals → "12.5": at most `maxFraction` fraction digits, trailing zeros
 * trimmed, and never rounded up (audit C-06). A positive amount too small to show reads
 * "<0.000001", never as the smallest visible unit.
 */
export function formatUnits(value: bigint, decimals: number, maxFraction = 6): string {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const digits = Math.min(decimals, maxFraction);
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, digits).replace(/0+$/, '');
  if (whole === 0n && frac === '' && v > 0n) return `${negative ? '-' : ''}<0.${'0'.repeat(Math.max(0, digits - 1))}1`;
  const text = `${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
  return negative ? `-${text}` : text;
}

/** Every digit, for amounts that are a promise, such as the minimum received. */
export const formatExact = (value: bigint, decimals: number) => formatUnits(value, decimals, decimals);

export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function formatUsd(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 2 });
}
