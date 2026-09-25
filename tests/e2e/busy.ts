/**
 * The page under load, in a real browser (Microsoft Edge via Playwright) against a production build.
 * Jupiter's and the RPC's refusals are made here, on the page's own requests to /api:
 *
 *   A. the price is refused with 429 at first: the page says it is retrying, never "no price";
 *   B. every protected route is refused with 429: the click says "too many requests", never
 *      "no route fits, try another token";
 *   C. the RPC refuses two simulations with 429: a production build still retries them and the
 *      swap reaches the wallet (kit's production errors carry no "429" in their text);
 *   D. /api/status fails twice: the page says so, retries, and recovers without a reload.
 *
 * The test wallet returns transactions unsigned, so nothing is ever sent (as in smoke.ts).
 *
 *   npm run build && npm run start   (in apps/web)
 *   node tests/e2e/busy.ts [http://localhost:3000]
 */
import { chromium } from 'playwright-core';
import type { Page, Route } from 'playwright-core';
import { getAddressEncoder, address } from '@solana/kit';

const URL = process.argv[2] ?? 'http://localhost:3000';
const SIM_WALLET = 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE';
const QUOTE_TAKER = '11111111111111111111111111111111';
const publicKey = Array.from(getAddressEncoder().encode(address(SIM_WALLET)));

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const tooMany = (route: Route) =>
  route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"Too many requests"}' });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(({ addr, key }) => {
    const account = { address: addr, publicKey: new Uint8Array(key), chains: ['solana:mainnet'], features: ['solana:signTransaction'], label: 'Test' };
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
          signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
            (window as unknown as { __signCalls: number }).__signCalls = ((window as unknown as { __signCalls?: number }).__signCalls ?? 0) + 1;
            return inputs.map(i => ({ signedTransaction: i.transaction }));
          },
        },
      },
    };
    const callback = ({ register }: { register: (w: unknown) => void }) => register(wallet);
    window.addEventListener('wallet-standard:app-ready', (e: Event) => callback((e as CustomEvent).detail));
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: callback }));
  }, { addr: SIM_WALLET, key: publicKey });

  // What Jupiter and the RPC answer, switched by the steps below.
  const jupiter = { quoteRefusals: 6, protectedRefused: true };
  const rpc = { simulationRefusals: 0 };
  let sends = 0;
  await context.route('**/api/jupiter/build**', route => {
    const taker = new globalThis.URL(route.request().url()).searchParams.get('taker');
    if (taker === QUOTE_TAKER) return jupiter.quoteRefusals-- > 0 ? tooMany(route) : route.continue();
    return jupiter.protectedRefused ? tooMany(route) : route.continue();
  });
  await context.route('**/api/rpc', route => {
    const method = (() => { try { return JSON.parse(route.request().postData() ?? '{}').method; } catch { return ''; } })();
    if (method === 'sendTransaction') sends++;
    if (method === 'simulateTransaction' && rpc.simulationRefusals > 0) {
      rpc.simulationRefusals--;
      return route.fulfill({ status: 429, contentType: 'application/json', body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32005,"message":"Too many requests"}}' });
    }
    return route.continue();
  });

  const page = await context.newPage();
  const labels: string[] = [];
  const button = page.locator('button.primary').last();
  // Every label the swap button shows, sampled while the steps run.
  const watch = setInterval(() => { button.innerText({ timeout: 200 }).then(t => labels.push(t)).catch(() => undefined); }, 100);

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /USDC/ }).first().waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Connect wallet' }).first().click();
  await page.getByRole('button', { name: 'Orientim Test Wallet' }).click();
  await page.getByText('GJRs…7npE').waitFor({ timeout: 10_000 });

  // A: the price, refused at first.
  await page.getByLabel('Amount to pay').fill('5');
  await page.locator('.detail-row', { hasText: /Minimum received.*SOL/ }).waitFor({ timeout: 90_000 });
  check('A. a busy price is retried until it arrives', true);
  check('A. the button says the prices are busy while it retries', labels.includes('Prices are busy, retrying…'), [...new Set(labels)].join(' | '));
  // The labels in the order they were seen, each once per stretch: says when a wrong one appeared.
  const sequence = labels.filter((l, i) => l !== labels[i - 1]).join(' → ');
  check('A. and never "No price for this pair"', !labels.includes('No price for this pair right now'), sequence);

  // B: every protected route refused.
  await page.getByRole('button', { name: 'Protected swap' }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Protected swap' }).click();
  const notice = page.locator('.banner[role="status"]');
  await notice.waitFor({ timeout: 90_000 });
  const b = (await notice.innerText()).replace(/\s+/g, ' ');
  check('B. a busy Jupiter at the click is told as too many requests', /Too many requests right now/.test(b) && /Nothing was signed/.test(b), b);
  check('B. not as a missing route', !/No route|different amount or token/i.test(b));

  // C: Jupiter answers again; the RPC refuses two simulations.
  jupiter.protectedRefused = false;
  rpc.simulationRefusals = 2;
  await page.waitForTimeout(6_000); // the page's cool-down after the 429s
  await page.getByRole('button', { name: 'Protected swap' }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Protected swap' }).click();
  await notice.waitFor({ state: 'detached', timeout: 10_000 }); // B's message, cleared by the click
  const moved = page.getByRole('button', { name: 'Continue with the new minimum' });
  await Promise.race([notice.waitFor({ timeout: 90_000 }), moved.waitFor({ timeout: 90_000 }).then(() => moved.click())]);
  await notice.waitFor({ timeout: 90_000 });
  const c = (await notice.innerText()).replace(/\s+/g, ' ');
  const signCalls = await page.evaluate(() => (window as unknown as { __signCalls?: number }).__signCalls ?? 0);
  check('C. an RPC 429 is retried in the production build and the swap reaches the wallet', signCalls === 1 && rpc.simulationRefusals === 0, `${signCalls} wallet call(s); then: ${c}`);
  check('C. no raw "Solana error #" code reaches the page', !/Solana error #/.test(c));
  check('nothing was ever sent', sends === 0);
  clearInterval(watch);

  // D: the page's settings, unreachable twice.
  const fresh = await context.newPage();
  let statusFailures = 2;
  await fresh.route('**/api/status', route => (statusFailures-- > 0 ? route.fulfill({ status: 503, body: 'down' }) : route.continue()));
  await fresh.goto(URL);
  await fresh.getByText("Couldn't reach Orientim").waitFor({ timeout: 15_000 });
  await fresh.getByText("Couldn't reach Orientim").waitFor({ state: 'detached', timeout: 30_000 });
  check('D. an unreachable status is retried, and the page recovers without a reload', statusFailures < 0);
  await stillWorks(fresh);
} finally {
  await browser.close();
}

/** After recovering, the page accepts an amount and prices it. */
async function stillWorks(p: Page) {
  await p.getByRole('button', { name: 'Connect wallet' }).first().click();
  await p.getByRole('button', { name: 'Orientim Test Wallet' }).click();
  await p.getByLabel('Amount to pay').fill('5');
  await p.locator('.detail-row', { hasText: /Minimum received.*SOL/ }).waitFor({ timeout: 60_000 });
  check('D. and then prices a swap', true);
}

const failed = results.filter(r => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
