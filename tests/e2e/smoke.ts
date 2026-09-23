/**
 * End-to-end smoke test of the dApp in a real browser (Microsoft Edge via Playwright).
 *
 * A test wallet is registered through the Wallet Standard. Its account is a public exchange wallet
 * (so the in-browser simulation has funds) and its signTransaction returns the transaction
 * UNSIGNED. The full pipeline runs in the browser — Jupiter via /api, simulation, the 7-rule
 * verifier — and the page must then stop at R6 ("the wallet did not sign") without sending.
 *
 *   npm run build && npm run start   (in apps/web)
 *   node tests/e2e/smoke.ts [http://localhost:3000]
 */
import { chromium } from 'playwright-core';
import { getAddressEncoder, address } from '@solana/kit';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://localhost:3000';
const OUT = 'tests/e2e/screenshots';
const SIM_WALLET = 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE';
const publicKey = Array.from(getAddressEncoder().encode(address(SIM_WALLET)));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(({ addr, key }) => {
    const account = {
      address: addr,
      publicKey: new Uint8Array(key),
      chains: ['solana:mainnet'],
      features: ['solana:signTransaction'],
      label: 'Test',
    };
    const wallet = {
      version: '1.0.0',
      name: 'Bound Test Wallet',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyIDIiPjxyZWN0IHdpZHRoPSIyIiBoZWlnaHQ9IjIiIGZpbGw9IiM4ODgiLz48L3N2Zz4=',
      chains: ['solana:mainnet'],
      accounts: [account],
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
        'standard:events': { version: '1.0.0', on: () => () => {} },
        'solana:signTransaction': {
          version: '1.0.0',
          supportedTransactionVersions: ['legacy', 0],
          // Returns the transaction without signing it: the dApp must refuse to continue (R6).
          signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
            (window as unknown as { __signCalls: number }).__signCalls = ((window as unknown as { __signCalls?: number }).__signCalls ?? 0) + 1;
            (window as unknown as { __signAt: number }).__signAt = Date.now();
            return inputs.map(i => ({ signedTransaction: i.transaction }));
          },
        },
      },
    };
    const callback = ({ register }: { register: (w: unknown) => void }) => register(wallet);
    window.addEventListener('wallet-standard:app-ready', (e: Event) => callback((e as CustomEvent).detail));
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: callback }));
  }, { addr: SIM_WALLET, key: publicKey });

  const page = await context.newPage();
  const errors: string[] = [];
  const rpcMethods: string[] = [];
  const images: string[] = [];
  const jupiterTakers: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  // A 404 from /api/token-icon is expected for tokens whose icon host is not on the server's list:
  // the page then shows a letter. Every other console error counts, including CSP violations.
  // Keyless Jupiter rate-limits bursts (HTTP 429); the client retries with backoff, so a 429 on
  // /api/jupiter/* is logged by the browser but handled by the app.
  let jupiter429 = 0;
  const expected = (m: { text(): string; location(): { url: string } }) => {
    const url = m.location().url;
    if (/status of 404/.test(m.text()) && url.includes('/api/token-icon')) return true;
    if (/status of 429/.test(m.text()) && url.includes('/api/jupiter/')) return ++jupiter429 > 0;
    return false;
  };
  page.on('console', m => m.type() === 'error' && !expected(m) && errors.push(`${m.text()} @ ${m.location().url}`));
  page.on('request', r => {
    if (r.resourceType() === 'image') images.push(r.url());
    if (r.url().includes('/api/jupiter/build')) jupiterTakers.push(new globalThis.URL(r.url()).searchParams.get('taker') ?? '');
    if (r.url().endsWith('/api/rpc')) {
      try { rpcMethods.push(JSON.parse(r.postData() ?? '{}').method); } catch { /* ignore */ }
    }
  });

  const first = await page.goto(URL, { waitUntil: 'networkidle' });
  const csp = first?.headers()['content-security-policy'] ?? '';
  const second = (await context.request.get(URL)).headers()['content-security-policy'] ?? '';
  const nonceOf = (h: string) => /'nonce-([^']+)'/.exec(h)?.[1] ?? null;
  const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? '';
  check(
    'CSP: per-request script nonce, no unsafe-inline scripts, images only from Bound',
    !!nonceOf(csp) && nonceOf(csp) !== nonceOf(second) && !scriptSrc.includes('unsafe-inline') && /img-src 'self' data:(;|$)/.test(csp),
    csp,
  );
  // Subresource integrity: the browser refuses a script whose bytes were altered on the way. Next
  // signs its bootstrap chunks and the page signs its own (lib/server/scriptIntegrity.ts); Next's
  // layout chunk is written before any page code runs, so one tag is allowed without a hash.
  const scripts = await page.$$eval('script[src^="/_next/static"]', tags =>
    tags.map(t => ({ src: t.getAttribute('src') ?? '', integrity: !!t.getAttribute('integrity') })));
  const unsigned = scripts.filter(x => !x.integrity).map(x => x.src.split('/').pop());
  check(
    'scripts carry subresource integrity hashes',
    scripts.length > 0 && unsigned.length <= 1,
    `${scripts.length - unsigned.length} of ${scripts.length} script tags; without: ${unsigned.join(', ') || 'none'} (covered by the published build digest)`,
  );

  await page.getByRole('button', { name: /USDC/ }).first().waitFor({ timeout: 20_000 });
  check('page loads with USDC → SOL preselected', await page.getByRole('button', { name: /SOL/ }).first().isVisible());
  check('protection panel is shown', await page.getByText('Wallet authority protected').isVisible());
  check('protection is one plain line', await page.getByText('The swap can touch only the amount you swap.').isVisible());
  check('test mode banner without a treasury', await page.getByText('Test mode: no Bound fee is charged.').isVisible());
  await page.screenshot({ path: `${OUT}/1-start.png` });

  await page.getByRole('button', { name: 'Connect wallet' }).first().click();
  await page.getByRole('button', { name: 'Bound Test Wallet' }).click();
  await page.getByText('GJRs…7npE').waitFor({ timeout: 10_000 });
  check('test wallet connects through the Wallet Standard', true);

  await page.getByLabel('Amount to pay').fill('5');
  await page.getByText(/Minimum output .* SOL · enforced on successful execution/).waitFor({ timeout: 20_000 });
  check('live quote appears', true, await page.locator('.box').nth(1).locator('.amount').innerText());
  await page.screenshot({ path: `${OUT}/2-quote.png` });

  const clickedAt = await page.evaluate(() => Date.now());
  await page.getByRole('button', { name: 'Protected swap' }).click();
  const banner = page.locator('.banner.error');
  // If the price moved beyond the tolerance between the quote and the build, Bound asks first (C-02).
  const moved = page.getByRole('button', { name: 'Continue with the new minimum' });
  await Promise.race([banner.waitFor({ timeout: 90_000 }), moved.waitFor({ timeout: 90_000 }).then(() => moved.click())]);
  await banner.waitFor({ timeout: 90_000 });
  const text = await banner.innerText();
  const signCalls = await page.evaluate(() => (window as unknown as { __signCalls?: number }).__signCalls ?? 0);
  const signAt = await page.evaluate(() => (window as unknown as { __signAt?: number }).__signAt ?? 0);
  check('the wallet was asked to sign once', signCalls === 1, `${signCalls} call(s), ${signAt - clickedAt} ms from click to wallet (quotes, reads, simulation, verification)`);
  check('an unsigned return is stopped by R6', /didn't sign/i.test(text) && /R6/.test(text), text.replace(/\s+/g, ' '));
  check('nothing was sent', !rpcMethods.includes('sendTransaction'), `RPC methods used: ${[...new Set(rpcMethods)].join(', ')}`);
  check(
    "Jupiter never receives the wallet's address",
    jupiterTakers.length > 0 && !jupiterTakers.includes(SIM_WALLET),
    `${jupiterTakers.length} build request(s)`,
  );
  await page.screenshot({ path: `${OUT}/3-r6-stop.png` });

  await page.getByRole('button', { name: /USDC/ }).first().click();
  await page.getByPlaceholder('Search by name, symbol or address').fill('bonk');
  await page.getByText('Bonk', { exact: false }).first().waitFor({ timeout: 15_000 });
  check('token search works', true);
  await page.getByPlaceholder('Search by name, symbol or address').fill('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  await page.getByText('Bonk', { exact: false }).first().waitFor({ timeout: 15_000 });
  check('pasting a token address finds it', true);
  await page.screenshot({ path: `${OUT}/4-search.png` });
  const foreign = images.filter(u => !u.startsWith(URL) && !u.startsWith('data:'));
  const icons = images.filter(u => u.includes('/api/token-icon')).length;
  check('every image comes from Bound (no third-party icon hosts)', foreign.length === 0 && icons > 0, `${icons} icon request(s)${foreign.length ? `, foreign: ${foreign.slice(0, 3).join(', ')}` : ''}`);

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const m = await mobile.newPage();
  await m.goto(URL, { waitUntil: 'networkidle' });
  await m.getByText('Wallet authority protected').waitFor({ timeout: 20_000 });
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('mobile layout has no horizontal scroll', !overflow);
  await m.getByRole('button', { name: 'Connect wallet' }).first().click();
  check('mobile without a wallet offers "open in Phantom"', await m.getByRole('link', { name: 'Phantom' }).isVisible());
  await m.screenshot({ path: `${OUT}/5-mobile.png`, fullPage: true });

  const relevant = errors.filter(e => !/favicon/i.test(e));
  check('no errors in the browser console', relevant.length === 0, relevant.join(' | ').slice(0, 300) || `${jupiter429} Jupiter 429(s), retried`);
} finally {
  await browser.close();
}

const failed = results.filter(r => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${OUT}/`);
process.exit(failed ? 1 : 0);
