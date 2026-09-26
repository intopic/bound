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
import { getAddressEncoder, address, getBase58Decoder } from '@solana/kit';
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
      name: 'Orientim Test Wallet',
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
    'CSP: per-request script nonce, no unsafe-inline scripts, images only from Orientim',
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
  check('the card is the protected swap', await page.getByText('Protected swap', { exact: true }).first().isVisible());
  check('test mode banner without a treasury', await page.getByText('Test mode: no Orientim fee is charged.').isVisible());
  await page.screenshot({ path: `${OUT}/1-start.png` });

  await page.getByRole('button', { name: 'Connect wallet' }).first().click();
  await page.getByRole('button', { name: 'Orientim Test Wallet' }).click();
  await page.getByText('GJRs…7npE').waitFor({ timeout: 10_000 });
  check('test wallet connects through the Wallet Standard', true);

  await page.getByLabel('Amount to pay').fill('5');
  await page.locator('.detail-row', { hasText: /Minimum received.*SOL/ }).waitFor({ timeout: 20_000 });
  check('live quote appears', true, await page.locator('.box').nth(1).locator('.amount').innerText());
  check('with a quote, the limits of this swap are shown', await page.getByText('Spend limit').isVisible()
    && await page.getByText('Stays with you').isVisible());
  await page.screenshot({ path: `${OUT}/2-quote.png` });

  const clickedAt = await page.evaluate(() => Date.now());
  await page.getByRole('button', { name: 'Protected swap' }).click();
  const banner = page.locator('.banner.error');
  // If the price moved beyond the tolerance between the quote and the build, Orientim asks first (C-02).
  const moved = page.getByRole('button', { name: 'Continue with the new minimum' });
  await Promise.race([banner.waitFor({ timeout: 90_000 }), moved.waitFor({ timeout: 90_000 }).then(() => moved.click())]);
  await banner.waitFor({ timeout: 90_000 });
  const text = await banner.innerText();
  const signCalls = await page.evaluate(() => (window as unknown as { __signCalls?: number }).__signCalls ?? 0);
  const signAt = await page.evaluate(() => (window as unknown as { __signAt?: number }).__signAt ?? 0);
  check('the wallet was asked to sign once', signCalls === 1, `${signCalls} call(s), ${signAt - clickedAt} ms from click to wallet (quotes, reads, simulation, verification)`);
  // Stopped by R6, said in plain words: the rule's name goes to the console, not to the person swapping.
  check('an unsigned return is stopped by R6', /didn't sign/i.test(text) && /Nothing was sent/.test(text) && !/\(R\d/.test(text), text.replace(/\s+/g, ' '));
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
  check('every image comes from Orientim (no third-party icon hosts)', foreign.length === 0 && icons > 0, `${icons} icon request(s)${foreign.length ? `, foreign: ${foreign.slice(0, 3).join(', ')}` : ''}`);

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const m = await mobile.newPage();
  await m.goto(URL, { waitUntil: 'networkidle' });
  await m.getByText('Protected swap', { exact: true }).first().waitFor({ timeout: 20_000 });
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('mobile layout has no horizontal scroll', !overflow);
  await m.getByRole('button', { name: 'Connect wallet' }).first().click();
  check('mobile without a wallet offers "open in Phantom"', await m.getByRole('link', { name: 'Phantom' }).isVisible());
  await m.screenshot({ path: `${OUT}/5-mobile.png`, fullPage: true });
  // The wallet list is a window over the page, as on swap sites: Escape closes it.
  await m.keyboard.press('Escape');
  check('the wallet window closes with Escape', !(await m.getByRole('dialog').isVisible()));

  // The page that says what is and is not guaranteed, one tap from the swap (final audit, M3).
  await m.getByRole('link', { name: 'Security', exact: true }).last().click();
  await m.getByRole('heading', { name: 'How Orientim protects you' }).waitFor({ timeout: 15_000 });
  const howOverflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('"How Orientim protects you" opens from the swap page and fits a phone', !howOverflow);
  await m.screenshot({ path: `${OUT}/7-how.png`, fullPage: true });

  // M-04 (final audit, Stage 2): the wallet never opens on a lifetime Orientim could not read, nor on
  // one that has run out. The RPC's block height is answered 503, then far past the swap's lifetime.
  for (const [what, answer, expected] of [
    ['cannot read the block height', 'fail', "Couldn't reach the network"],
    ["the swap's lifetime has run out", 'late', 'The swap expired'],
  ] as const) {
    const p = await context.newPage();
    let heightAsked = 0;
    await p.route('**/api/rpc', async route => {
      const body = JSON.parse(route.request().postData() ?? '{}') as { id?: unknown; method?: string };
      if (body.method !== 'getBlockHeight') return route.continue();
      heightAsked++;
      if (answer === 'fail') return route.fulfill({ status: 503, body: 'unavailable' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 999_999_999_999 }) });
    });
    await p.goto(URL, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'Connect wallet' }).first().click();
    await p.getByRole('button', { name: 'Orientim Test Wallet' }).click();
    await p.getByLabel('Amount to pay').fill('5');
    await p.locator('.detail-row', { hasText: /Minimum received.*SOL/ }).waitFor({ timeout: 20_000 });
    // Keyless Jupiter may answer "busy" first: that notice is load, not the case under test, so the
    // swap is asked again a few times; whatever shows, the wallet must never have been asked.
    let seen = '';
    for (let attempt = 0; attempt < 4 && !seen.includes(expected); attempt++) {
      if (attempt) await p.waitForTimeout(6_000);
      await p.getByRole('button', { name: 'Protected swap' }).click();
      const moved = p.getByRole('button', { name: 'Continue with the new minimum' });
      const banner = p.locator('.banner.error, .banner.info').filter({ hasNotText: 'Test mode' }).first();
      await Promise.race([banner.waitFor({ timeout: 120_000 }), moved.waitFor({ timeout: 120_000 }).then(() => moved.click())]);
      await banner.waitFor({ timeout: 120_000 });
      seen = (await banner.innerText()).replace(/\s+/g, ' ');
    }
    const calls = await p.evaluate(() => (window as unknown as { __signCalls?: number }).__signCalls ?? 0);
    // Under keyless Jupiter the rebuilds of an expired swap may end in "busy" before the expiry
    // notice: still a pass when the gate ran and the wallet was never asked.
    const load = /Too many requests|price service/.test(seen);
    check(
      `the wallet does not open when Orientim ${what}`,
      calls === 0 && heightAsked > 0 && (seen.includes(expected) || load),
      `${calls} signature request(s), ${heightAsked} height read(s); "${seen.slice(0, 100)}"`,
    );
    await p.close();
  }

  // The owner's rule on cost: someone trying amounts costs a build or two ahead of the click, not one
  // per amount. Three amounts a second and a half apart asked Jupiter 18 times before the rule.
  {
    const p = await context.newPage();
    // Answers Jupiter gave, not its 429s: without a key it refuses bursts, and the page asks again.
    let builds = 0;
    let refused = 0;
    p.on('response', r => {
      if (!r.url().includes('/api/jupiter/build')) return;
      if (r.status() === 429) refused++;
      else builds++;
    });
    await p.goto(URL, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'Connect wallet' }).first().click();
    await p.getByRole('button', { name: 'Orientim Test Wallet' }).click();
    for (const amount of ['7', '9', '12']) {
      await p.getByLabel('Amount to pay').fill(amount);
      await p.waitForTimeout(1_500);
    }
    await p.locator('.detail-row', { hasText: /Minimum received.*SOL/ }).waitFor({ timeout: 30_000 });
    await p.waitForTimeout(8_000);
    check('trying three amounts costs a few price requests, not one build per amount', builds <= 8, `${builds} answered by Jupiter, ${refused} refused as busy`);
    await p.close();
  }

  // Third audit, F2: a swap from this wallet that the chain has not settled holds the next one back,
  // whatever the time. One that can no longer land, and that nothing proves either way, the person
  // sets aside by hand once they looked it up.
  {
    const p = await context.newPage();
    await p.goto(URL, { waitUntil: 'networkidle' });
    const signature = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)));
    await p.evaluate(([addr, sig]) => localStorage.setItem('orientim.history.v1', JSON.stringify([{
      at: Date.now() - 86_400_000, signature: sig, status: 'unknown', owner: addr, lastValidBlockHeight: '1', over: true,
      paid: '5 USDC', received: '', exposed: '5 USDC',
    }])), [SIM_WALLET, signature]);
    await p.reload({ waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'Connect wallet' }).first().click();
    await p.getByRole('button', { name: 'Orientim Test Wallet' }).click();
    await p.getByLabel('Amount to pay').fill('5');
    const waiting = p.getByRole('button', { name: 'Waiting for your last swap' });
    await waiting.waitFor({ timeout: 20_000 });
    const held = await waiting.isDisabled();
    await p.screenshot({ path: `${OUT}/8-waiting.png` });
    await p.getByRole('button', { name: "I've checked it" }).click();
    const freed = await p.getByRole('button', { name: 'Waiting for your last swap' }).waitFor({ state: 'detached', timeout: 20_000 }).then(() => true, () => false);
    check('an unsettled swap from this wallet holds the next one back until it is settled or set aside', held && freed);
    await p.close();
  }

  // Third audit, F3: a browser that will not keep the swap's record sends nothing, and says so before
  // the wallet opens.
  {
    const p = await context.newPage();
    await p.addInitScript(() => {
      Storage.prototype.setItem = function setItem() { throw new DOMException('Site data is blocked.', 'SecurityError'); };
    });
    await p.goto(URL, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'Connect wallet' }).first().click();
    await p.getByRole('button', { name: 'Orientim Test Wallet' }).click();
    await p.getByLabel('Amount to pay').fill('5');
    await p.locator('.detail-row', { hasText: /Minimum received.*SOL/ }).waitFor({ timeout: 30_000 });
    await p.getByRole('button', { name: 'Protected swap' }).click();
    const banner = p.locator('.banner.error').first();
    await banner.waitFor({ timeout: 20_000 });
    const said = (await banner.innerText()).replace(/\s+/g, ' ');
    const calls = await p.evaluate(() => (window as unknown as { __signCalls?: number }).__signCalls ?? 0);
    check("a browser that won't keep the record opens no wallet and sends nothing", calls === 0 && /isn't saving this site's data/.test(said) && /Nothing was sent/.test(said), said.slice(0, 120));
    await p.close();
  }

  const relevant = errors.filter(e => !/favicon/i.test(e));
  check('no errors in the browser console', relevant.length === 0, relevant.join(' | ').slice(0, 300) || `${jupiter429} Jupiter 429(s), retried`);
} finally {
  await browser.close();
}

const failed = results.filter(r => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${OUT}/`);
process.exit(failed ? 1 : 0);
