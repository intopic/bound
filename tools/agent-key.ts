/**
 * Makes what the agent API needs (AGENT-API.md). Nothing is stored anywhere by this script.
 *
 *   node tools/agent-key.ts <id>       a new API key for one agent or bot: give the key to its
 *                                      owner once, add the printed entry to ORIENTIM_API_KEYS
 *   node tools/agent-key.ts --secret   a new ORIENTIM_API_SECRET (move the old one to
 *                                      ORIENTIM_API_SECRET_PREVIOUS for a minute while it rotates)
 */
import { createHash, randomBytes } from 'node:crypto';

const arg = process.argv[2];
if (arg === '--secret') {
  console.log(`ORIENTIM_API_SECRET=${randomBytes(32).toString('base64')}`);
} else if (arg && /^[\w-]{1,40}$/.test(arg)) {
  const key = `ori_${randomBytes(24).toString('base64url')}`;
  console.log(`API key for ${arg} (shown once; Orientim keeps only its hash):\n  ${key}\n`);
  console.log(`Add to ORIENTIM_API_KEYS (comma-separated):\n  ${arg}:${createHash('sha256').update(key).digest('hex')}`);
} else {
  console.error('usage: node tools/agent-key.ts <id> | --secret   (id: letters, digits, _ or -, up to 40)');
  process.exit(2);
}
