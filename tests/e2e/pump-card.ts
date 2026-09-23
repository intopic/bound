/**
 * The costs a Pump.fun buy shows before the wallet opens (review FA-05), in a real browser (Edge)
 * against a production build: the market's per-buyer account is closed in the same swap, so the card
 * must say how much of the market's charge comes back. When all of it comes back (PumpSwap, or a curve
 * that does not grow), there is nothing to ask and the wallet opens directly. SOL → Pump.fun tokens
 * listed as recent, until one shows the card. The test wallet returns nothing signed; nothing is sent.
 *
 *   npm run build && npm run start   (in apps/web)
 *   node tests/e2e/pump-card.ts [http://localhost:3000]
 */
import { chromium } from 'playwright-core';
import { getAddressEncoder, address } from '@solana/kit';

const URL = process.argv[2] ?? 'http://localhost:3000';
const SIM_WALLET = 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE';
const publicKey = Array.from(getAddressEncoder().encode(address(SIM_WALLET)));

type Listed = { id: string; symbol: string };
const list = async (url: string) => fetch(url).then(r => r.json() as Promise<Listed[]>).catch(() => [] as Listed[]);
const listed = [...await list('https://lite-api.jup.ag/tokens/v2/recent'), ...await list('https://lite-api.jup.ag/tokens/v2/toptrending/1h?limit=100')];
const candidates = listed.filter((t, i) => t.id.endsWith('pump') && listed.findIndex(x => x.id === t.id) === i).slice(0, 14);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
let result: { ok: boolean; detail: string } = { ok: false, detail: 'no token showed the card' };
let straight = 0;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(({ addr, key }) => {
    const account = { address: addr, publicKey: new Uint8Array(key), chains: ['solana:mainnet'], features: ['solana:signTransaction'], label: 'Test' };
    const wallet = {
      version: '1.0.0', name: 'Bound Test Wallet',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyIDIiPjxyZWN0IHdpZHRoPSIyIiBoZWlnaHQ9IjIiIGZpbGw9IiM4ODgiLz48L3N2Zz4=',
      chains: ['solana:mainnet'], accounts: [account],
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
        'standard:events': { version: '1.0.0', on: () => () => {} },
        'solana:signTransaction': {
          version: '1.0.0', supportedTransactionVersions: ['legacy', 0],
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

  for (const t of candidates) {
    const page = await context.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /USDC/ }).first().waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Connect wallet' }).first().click();
    await page.getByRole('button', { name: 'Bound Test Wallet' }).click();
    // SOL in, the Pump.fun token out.
    await page.getByRole('button', { name: 'Switch tokens' }).click();
    await page.locator('.box').nth(1).locator('button.token').click();
    await page.getByPlaceholder('Search by name, symbol or address').fill(t.id);
    const item = page.locator('.picker-item:not([disabled])').first();
    if (!(await item.waitFor({ timeout: 15_000 }).then(() => true, () => false))) { await page.close(); continue; }
    await item.click();
    await page.getByLabel('Amount to pay').fill('0.02');
    if (!(await page.getByText(/Minimum received/).waitFor({ timeout: 30_000 }).then(() => true, () => false))) { await page.close(); continue; }
    await page.getByRole('button', { name: 'Protected swap' }).click();
    const card = page.getByRole('alertdialog', { name: 'Before your wallet opens' });
    const other = page.locator('.banner[role="status"]');
    await Promise.race([card.waitFor({ timeout: 90_000 }), other.waitFor({ timeout: 90_000 })]).catch(() => undefined);
    if (await card.isVisible()) {
      const text = (await card.innerText()).replace(/\s+/g, ' ');
      const signCalls = await page.evaluate(() => (window as unknown as { __signCalls?: number }).__signCalls ?? 0);
      result = {
        ok: /comes straight back to you/.test(text) && /Market account fee/.test(text) && signCalls === 0,
        detail: `${t.symbol}: ${text.slice(0, 400)}`,
      };
      await card.getByRole('button', { name: 'Cancel' }).click();
      await page.close();
      break;
    }
    // No question: the market kept nothing, and the wallet was asked straight away.
    if (await page.evaluate(() => (window as unknown as { __signCalls?: number }).__signCalls ?? 0)) {
      straight++;
      console.log(`     ${t.symbol}: no card, the wallet opened directly (all of the market's charge comes back, or none is charged)`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`${result.ok ? 'OK ' : 'FAIL'} the costs card says how much of the market's charge comes back — ${result.detail}`);
console.log(`     ${straight} token(s) went straight to the wallet with nothing to ask`);
process.exitCode = result.ok ? 0 : 1;
