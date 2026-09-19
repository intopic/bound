/**
 * End-to-end test of the signing flow on devnet (free): the wallet signs first, the page checks the
 * returned message byte for byte, E signs last, and the transaction is sent and confirmed.
 *
 * The test wallet holds a real Ed25519 key generated inside the browser and signs exactly like a
 * wallet extension would. SOL comes from the devnet faucet (rate limited; may need a retry).
 *
 *   (in spikes/wallet-test) npx vite --port 5173
 *   node tests/e2e/devnet.ts [http://localhost:5173/devnet.html]
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://localhost:5173/devnet.html';
const OUT = 'tests/e2e/screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    if (!globalThis.crypto?.subtle) return; // about:blank before navigation
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const base58 = (bytes: Uint8Array) => {
      let n = 0n;
      for (const b of bytes) n = n * 256n + BigInt(b);
      let s = '';
      while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
      for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
      return s;
    };
    const ready = (async () => {
      const keys = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])) as CryptoKeyPair;
      const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
      const account = { address: base58(publicKey), publicKey, chains: ['solana:devnet'], features: ['solana:signTransaction'], label: 'Test' };
      const wallet = {
        version: '1.0.0',
        name: 'Bound Signing Test Wallet',
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyIDIiPjxyZWN0IHdpZHRoPSIyIiBoZWlnaHQ9IjIiIGZpbGw9IiM4ODgiLz48L3N2Zz4=',
        chains: ['solana:devnet'],
        accounts: [account],
        features: {
          'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
          'standard:events': { version: '1.0.0', on: () => () => {} },
          'solana:signTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            // Signs like a wallet: the fee payer is the first signer, signature slot 0.
            signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
              Promise.all(inputs.map(async ({ transaction }) => {
                const bytes = Uint8Array.from(transaction);
                const count = bytes[0]; // compact-u16, < 128 signatures
                const message = bytes.slice(1 + 64 * count);
                const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, message));
                bytes.set(signature, 1);
                return { signedTransaction: bytes };
              })),
          },
        },
      };
      return wallet;
    })();
    const register = ({ register }: { register: (w: unknown) => void }) => ready.then(w => register(w));
    window.addEventListener('wallet-standard:app-ready', (e: Event) => register((e as CustomEvent).detail));
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
  });

  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: /Bound Signing Test Wallet/ }).click();
  await page.getByText(/W = /).waitFor({ timeout: 10_000 });
  check('signing test wallet connects', true);

  let funded = false;
  for (let attempt = 0; attempt < 3 && !funded; attempt++) {
    await page.getByRole('button', { name: 'Merr 1 SOL devnet falas' }).click();
    const outcome = await Promise.race([
      page.getByText('Airdrop-i mbërriti.').waitFor({ timeout: 45_000 }).then(() => 'ok'),
      page.getByText(/Faucet-i i RPC-së refuzoi/).first().waitFor({ timeout: 45_000 }).then(() => 'limited'),
    ]).catch(() => 'timeout');
    funded = outcome === 'ok';
    if (!funded) await page.waitForTimeout(5000);
  }
  check('devnet airdrop', funded, funded ? '' : 'the public faucet is rate limited; rerun later or use faucet.solana.com');

  if (funded) {
    await page.getByRole('button', { name: 'Ndërto dhe simulo' }).click();
    await page.getByText(/simulimi kaloi/).waitFor({ timeout: 30_000 });
    check('test transaction builds and simulates on devnet', true);

    await page.getByRole('button', { name: 'Nënshkruaj me wallet' }).click();
    await page.getByText('Mesazhi që ktheu wallet-i është identik').waitFor({ timeout: 15_000 });
    check("W's signature is valid and the message is unchanged", await page.getByText('Nënshkrimi i W-së është i vlefshëm').isVisible());

    await page.getByRole('button', { name: 'E nënshkruan dhe dërgo' }).click();
    const outcome = await Promise.race([
      page.getByText('U konfirmua në devnet.').waitFor({ timeout: 90_000 }).then(() => 'confirmed'),
      page.getByText(/Dështoi|Skadoi/).waitFor({ timeout: 90_000 }).then(() => 'failed'),
    ]).catch(() => 'timeout');
    const link = await page.getByRole('link', { name: /Solana Explorer/ }).getAttribute('href').catch(() => '');
    check('E signs last, the transaction is sent and confirmed', outcome === 'confirmed', link ?? '');
  }
  await page.screenshot({ path: `${OUT}/6-devnet.png`, fullPage: true });
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
} finally {
  await browser.close();
}

const failed = results.filter(r => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
