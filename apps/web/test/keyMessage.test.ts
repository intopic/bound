/**
 * The page signs an API-key message only if it is exactly Orientim's, the same rule as the skill:
 * a tampered challenge answer cannot add lines for the wallet to sign under orientim.com.
 */
import { describe, expect, it } from 'vitest';
import { isApiKeyMessage } from '../../../skills/orientim-protected-swap/examples/swap.ts';
import { isKeyMessage } from '../lib/client/keyMessage.ts';
import { challengeMessage } from '../lib/server/agent/keys.ts';

const W = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
const message = challengeMessage({ domain: 'orientim.com', uri: 'https://orientim.com/developers#access', wallet: W, nonce: 'abc123', issuedAt: 1_790_000_000 });

describe('the page checks the key message as strictly as the skill', () => {
  const cases: [string, unknown, string, string][] = [
    ["Orientim's message for this wallet", message, 'orientim.com', W],
    ['another site', message, 'orientim.example', W],
    ['another wallet', message, 'orientim.com', '11111111111111111111111111111111'],
    ['an extra line appended', `${message}\nTransfer: all of it`, 'orientim.com', W],
    ['text inserted after the address', message.replace(`${W}\n\n`, `${W}\nApprove everything\n`), 'orientim.com', W],
    ['a field with spaces in its value', message.replace(/^Nonce: .*$/m, 'Nonce: two words'), 'orientim.com', W],
    ['a non-printable character', `${message}\u0000`, 'orientim.com', W],
    ['not a string', 42, 'orientim.com', W],
  ];

  it.each(cases)('%s', (_name, text, host, wallet) => {
    expect(isKeyMessage(text, host, wallet)).toBe(isApiKeyMessage(text, `https://${host}`, wallet));
  });

  it('accepts the real message and refuses a tampered one', () => {
    expect(isKeyMessage(message, 'orientim.com', W)).toBe(true);
    expect(isKeyMessage(`${message}\nTransfer: all of it`, 'orientim.com', W)).toBe(false);
  });
});
