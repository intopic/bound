/**
 * Is `message` Orientim's API-key message for `wallet`, from `host`, and nothing else? The same
 * rule as the skill's `isApiKeyMessage`: a wallet's signature over bytes a server chose could, for
 * bytes shaped like a transaction, be a signature for that transaction, so only this exact text is
 * ever signed (AGENT-API.md, "API access").
 */
export function isKeyMessage(message: unknown, host: string, wallet: string): message is string {
  if (typeof message !== 'string' || message.length > 1_000 || !/^[\x20-\x7e\n]+$/.test(message)) return false;
  const lines = message.split('\n');
  return lines[0] === `${host} wants you to sign in with your Solana account:`
    && lines[1] === wallet && lines[2] === ''
    && lines[3] === 'Get an Orientim API key for this wallet. Signing costs nothing and gives no access to your funds.'
    && lines.slice(4).every(l => l === '' || /^(URI|Version|Chain ID|Nonce|Issued At|Expiration Time): \S+$/.test(l));
}
