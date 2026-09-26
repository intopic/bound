# Orientim for Solana Agent Kit

Protected swaps for agents built on [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit) v2.
The route of each swap can use the amount the agent approved and nothing else in its wallet, and
every swap is checked on the agent's own RPC before its wallet signs.

```bash
npm install @orientim/plugin-solana-agent-kit
```

```ts
import { SolanaAgentKit, KeypairWallet, createVercelAITools } from 'solana-agent-kit';
import OrientimPlugin from '@orientim/plugin-solana-agent-kit';

const agent = new SolanaAgentKit(wallet, process.env.RPC_URL, {
  OTHER_API_KEYS: { ORIENTIM_API_KEY: process.env.ORIENTIM_API_KEY, JUPITER_API_KEY: process.env.JUPITER_API_KEY },
}).use(OrientimPlugin);

// In code: 0.1 SOL for USDC.
const result = await agent.methods.orientimSwap(agent, {
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  inputAmount: 0.1,
});
// { signature, outcome: 'confirmed', inputAmount: '0.1', minimumReceived: '…', explorer: 'https://solscan.io/tx/…', … }

// For a model: one tool, ORIENTIM_PROTECTED_SWAP (Vercel AI, LangChain and OpenAI Agents alike).
const tools = createVercelAITools(agent, agent.actions);
```

## API key

Get one on Orientim's docs page, under API access: connect the agent's wallet and sign one message.
Signing costs nothing and moves nothing. The key works for that wallet only.

Without `ORIENTIM_API_KEY`, the plugin gets a key itself: the agent's wallet signs Orientim's key
message once. The message is checked first: it must name this wallet and Orientim's host, as plain
text. The key is then kept in memory. A process that restarts often should store it:

```ts
import { createOrientimPlugin } from '@orientim/plugin-solana-agent-kit';

const plugin = createOrientimPlugin({ onApiKey: ({ key }) => saveSecret('ORIENTIM_API_KEY', key) });
```

`autoKey: false` turns this off.

## Options

`createOrientimPlugin(options)` takes:

| Option | Default | Use |
| --- | --- | --- |
| `apiUrl` | `https://orientim.com`, or `ORIENTIM_API_URL` in `OTHER_API_KEYS` | Orientim's address. |
| `apiKey` | `ORIENTIM_API_KEY` in `OTHER_API_KEYS` | The API key. |
| `autoKey` | `true` | Get a key by signing Orientim's key message when there is none. |
| `onApiKey` | | Called with a key obtained that way. |
| `rpcUrl` or `rpc` | the agent's connection | The RPC every check reads the chain from. Use your own. |
| `stateDir` or `store` | in memory | Where signed swaps and order ids are kept until settled. See below. |
| `maxSlippageBpsCap` | 500 | The most slippage tolerance anyone may choose, the model or your code (at most 1500). |
| `maxPriceImpactBps` | 500 | The most one swap may move the market. Above it the swap is refused before anything is prepared. Only you set it. |
| `jupiterApiKey` | `JUPITER_API_KEY` in `OTHER_API_KEYS` | For the price your own minimum is set from. |
| `maxWaitMs` | 3 minutes | How long to wait for the outcome. |
| `requestTimeoutMs` | 30 s for Orientim, 10 s for the RPC | How long one call may take. |

`orientimSwap(agent, input)` takes:

| Field | Use |
| --- | --- |
| `outputMint` | The token to receive. |
| `inputAmount` | How much to pay, in whole tokens, rounded down. Only this amount can be used. |
| `inputMint` | The token to pay with. SOL when absent. |
| `minOutput` | The least to receive, in whole tokens, rounded up. When absent, it follows the tolerance and Jupiter's price. |
| `slippageBps` | The slippage tolerance, as on the page: 10 up to `maxSlippageBpsCap` (0.5% by default, 3% on a Pump.fun curve). |
| `id` | Your order's id, the same on every retry. With a shared store, an order is never swapped twice. |

The tool the model sees, `ORIENTIM_PROTECTED_SWAP`, takes only `outputMint`, `inputAmount`, `inputMint`
and `slippageBps`. An order id and a minimum of your own are for your
code, through the method.

## Who decides what

- **The model** chooses the tokens, the amount and the slippage tolerance. The tolerance is always held
  under your `maxSlippageBpsCap`, and the price impact under your `maxPriceImpactBps`.
- **Orientim** holds each swap to its limits: the amount, the minimum, the fee of 0.3%, and a route
  that never gets the wallet.
- **You, the agent's owner,** decide everything else. The plugin sets no daily budget, no list of
  allowed tokens and no ceiling on the amount. Put those between the model and the tool if your
  agent needs them.

## Keeping swaps: stateDir or store

A swap that is signed but not yet settled is kept until its outcome is known. While it may still
land, no new swap starts from the same wallet, and an order id already used is not swapped again.

| Where the agent runs | Set |
| --- | --- |
| One long-running process | Nothing (memory). Set `acceptInMemoryState: true` to silence the warning. |
| Several processes on one machine, or one that restarts | `stateDir`: a directory on disk, with a lock per wallet. |
| Several servers, or serverless | `store`: your own, shared by all of them (a database). `claimOrder` must be atomic. |

Kept in memory, a swap is forgotten on restart and by a second process or server. Either of them
could then send a second swap while the first may still land. The plugin warns once when it has
neither `stateDir` nor `store`.

Within one process, one swap per wallet runs at a time, even when the plugin is loaded twice. A
second call waits for the first.

## Outcomes

- `confirmed`: the swap landed. `received` is what arrived, read from the transaction, and
  `minimumReceived` is the least it could deliver.
- `failed`: the transaction landed without swapping; only the network fee was spent.
- `expired`: the swap never landed and can no longer land.
- `unknown`: the swap may still land. No new swap starts from this wallet until it settles. Do not
  retry before its signature is checked.

A refusal before anything is signed throws an error with a `code`. The tool answers
`{ status: 'error', code, message }`. The codes are:

- Orientim's own: `costs-more`, `wrong-wallet`, `rate-limited`, and so on.
- `invalid-amount`, `invalid-mint`, `invalid-input`, `not-a-token` and `same-token`.
- `slippage-above-limit`: the tolerance asked is above `maxSlippageBpsCap`.
- `price-impact-high`: this amount would move the market more than `maxPriceImpactBps`, a sign of thin
  liquidity. Nothing was prepared.
- `swap-unsettled`, `record-not-updated`, `rpc-unavailable`, `sign-only` and `no-api-key`.

Every number in Orientim's answer is checked before the wallet signs. Once a swap is sent, its
signature and outcome always come back.

`signOnly` agents are not supported, because Orientim sends the swap once the wallet has signed it.

Each result carries `warnings`: notes about the tokens themselves, such as an issuer that can freeze
balances or mint more. The model is told them, as the page tells a person.

The fee is 0.3% of each swap.

## Requirements

- Node 22 or later.
- `solana-agent-kit` 2.0.10 or later (2.x).
- The project's own `@solana/web3.js` 1.98.2 or later, and `zod` 3.25 or later (3.x): the ones the
  Agent Kit uses. zod 4 is refused at install.
