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
| `stateDir` | in memory | Keep signed swaps and order ids on disk, with a lock per wallet across processes. |
| `jupiterApiKey` | `JUPITER_API_KEY` in `OTHER_API_KEYS` | For the price your own minimum is set from. |
| `maxWaitMs` | 3 minutes | How long to wait for the outcome. |

`orientimSwap(agent, input)` takes:

| Field | Use |
| --- | --- |
| `outputMint` | The token to receive. |
| `inputAmount` | How much to pay, in whole tokens. Only this amount can be used. |
| `inputMint` | The token to pay with. SOL when absent. |
| `minOutput` | The least to receive, in whole tokens. When absent, Jupiter's price less `maxBelowBps`. |
| `maxBelowBps` | How far below Jupiter's price the minimum may be (200 by default, 500 on a Pump.fun curve). |
| `id` | Your order's id, the same on every retry: an order is never swapped twice. |

## Outcomes

- `confirmed`: the swap landed.
- `failed`: the transaction landed without swapping; only the network fee was spent.
- `expired`: the swap never landed and can no longer land.
- `unknown`: the swap may still land. No new swap starts from this wallet until it settles.

A refusal throws an error with a `code` (the tool answers `{ status: 'error', code, message }`).
The codes are:

- Orientim's own: `costs-more`, `wrong-wallet`, `rate-limited`, and so on.
- `invalid-amount`, `invalid-mint`, `not-a-token` and `same-token`.
- `swap-unsettled`, `sign-only` and `no-api-key`.

One swap per wallet runs at a time: a second call waits for the first. `signOnly` agents are not
supported, because Orientim sends the swap once the wallet has signed it.

The fee is 0.3% of each swap.

## Requirements

- Node 22 or later.
- `solana-agent-kit` 2.
- The project's own `@solana/web3.js` 1.98 or later, and `zod` 3: the ones the Agent Kit uses.
