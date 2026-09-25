// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { OrientimError, JupiterError } from '@orientim/jupiter';
import { clearProblems, errorDetail, problemsReport, readProblems, recordProblem } from '../lib/client/problems.ts';
import type { Problem } from '../lib/client/problems.ts';

function fakeStorage() {
  const data = new Map<string, string>();
  const state = { refuse: false, data };
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (state.refuse) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k: string) => { data.delete(k); },
  };
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return state;
}

const problem = (at: number, title = `message ${at}`, more: Partial<Problem> = {}): Problem => ({ at, kind: 'error', title, ...more });

describe('the messages the page showed are kept in this browser', () => {
  afterEach(() => { delete (globalThis as { window?: unknown }).window; });

  it('newest first, the last 20 only', () => {
    fakeStorage();
    for (let i = 1; i <= 25; i++) recordProblem(problem(i * 10_000));
    const kept = readProblems();
    expect(kept).toHaveLength(20);
    expect(kept[0].title).toBe('message 250000');
    expect(kept[19].title).toBe('message 60000');
  });

  it('the same message again within seconds is kept once; later, or different, it is kept again', () => {
    fakeStorage();
    recordProblem(problem(1_000, 'busy'));
    recordProblem(problem(2_000, 'busy'));
    recordProblem(problem(3_000, 'other'));
    recordProblem(problem(20_000, 'other'));
    expect(readProblems().map(p => p.at)).toEqual([20_000, 3_000, 1_000]);
  });

  it('a long error is cut, not refused', () => {
    fakeStorage();
    recordProblem(problem(1, 'long', { detail: 'x'.repeat(10_000) }));
    expect(readProblems()[0].detail!.length).toBeLessThan(2_100);
  });

  it('blocked storage, a broken record or no window never throws', () => {
    const storage = fakeStorage();
    storage.refuse = true;
    expect(() => recordProblem(problem(1))).not.toThrow();
    expect(readProblems()).toEqual([]);
    storage.data.set('orientim.problems.v1', '{not json');
    expect(readProblems()).toEqual([]);
    delete (globalThis as { window?: unknown }).window;
    expect(() => recordProblem(problem(1))).not.toThrow();
    expect(readProblems()).toEqual([]);
    expect(() => clearProblems()).not.toThrow();
  });

  it('cleared, nothing is left', () => {
    fakeStorage();
    recordProblem(problem(1));
    clearProblems();
    expect(readProblems()).toEqual([]);
  });
});

describe('the raw error behind a message', () => {
  it("keeps Orientim's code, the verifier's violations and the words", () => {
    const d = errorDetail(new OrientimError('verification-failed', 'The transaction did not pass.', [{ rule: 'R2', detail: 'an extra writable account' }]));
    expect(d).toContain('The transaction did not pass.');
    expect(d).toContain('code: verification-failed');
    expect(d).toContain('an extra writable account');
  });

  it("keeps an HTTP status, a Solana error's context with its big numbers, and the cause", () => {
    expect(errorDetail(new JupiterError('Too many requests', 429))).toContain('status: 429');
    const solana = Object.assign(new Error('Solana error #8100002'), { context: { statusCode: 503, lamports: 5n } });
    expect(errorDetail(solana)).toContain('"statusCode":503');
    expect(errorDetail(solana)).toContain('"lamports":"5"');
    expect(errorDetail(new Error('outer', { cause: new TypeError('inner') }))).toContain('cause: TypeError: inner');
  });

  it('a thrown string or object is said as it is', () => {
    expect(errorDetail('User rejected the request.')).toBe('thrown: User rejected the request.');
    expect(errorDetail({ code: 4001 })).toBe('thrown: {"code":4001}');
  });

  it('the report carries every message, its context and its detail', () => {
    const text = problemsReport([problem(0, 'Something went wrong', { body: 'No funds moved.', context: '2 USDC → BONK, Phantom 1.0.0', detail: 'TypeError: x' })], 'test-browser');
    expect(text).toContain('Browser: test-browser');
    expect(text).toContain('1970-01-01T00:00:00.000Z [error] Something went wrong');
    expect(text).toContain('while: 2 USDC → BONK, Phantom 1.0.0');
    expect(text).toContain('TypeError: x');
  });
});
