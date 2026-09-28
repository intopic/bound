/**
 * A failed simulation is reported with the failing program's own words, not only its error number:
 * "Custom: 1" is a different error in every program.
 */
import { describe, expect, it } from 'vitest';
import { failureReason } from '../src/swap.ts';

describe('failureReason', () => {
  it('names what the token program said when a transfer inside a market failed', () => {
    expect(failureReason([
      'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]',
      'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [2]',
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3]',
      'Program log: Instruction: TransferChecked',
      'Program log: Error: insufficient funds',
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1',
      'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA failed: custom program error: 0x1',
      'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1',
    ])).toBe('Error: insufficient funds');
  });

  it('names a transfer of SOL that was short', () => {
    expect(failureReason([
      'Program 11111111111111111111111111111111 invoke [3]',
      'Transfer: insufficient lamports 100, need 2039280',
      'Program 11111111111111111111111111111111 failed: custom program error: 0x1',
    ])).toBe('Transfer: insufficient lamports 100, need 2039280');
  });

  it('falls back to the failure line when the program logged nothing', () => {
    expect(failureReason([
      'Program 11111111111111111111111111111111 invoke [1]',
      'Program 11111111111111111111111111111111 failed: invalid account data for instruction',
    ])).toBe('invalid account data for instruction');
  });

  it('says nothing for logs without a failure, and keeps a long line short', () => {
    expect(failureReason(['Program 11111111111111111111111111111111 success'])).toBeNull();
    const long = failureReason([`Program log: ${'x'.repeat(300)}`, 'Program Abc failed: custom program error: 0x1']);
    expect(long?.length).toBe(160);
  });
});
