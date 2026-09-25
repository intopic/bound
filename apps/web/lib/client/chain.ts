'use client';

import { createJupiterClient } from '@orientim/jupiter';
import type { JupiterClient } from '@orientim/jupiter';
import { createRetryingRpc } from '@orientim/solana';
import type { SolanaRpc } from '@orientim/solana';

// Every network call goes through Orientim's own stateless API routes (D8): the browser never sees
// RPC credentials or the Jupiter API key.
let rpc: SolanaRpc | null = null;
let jupiter: JupiterClient | null = null;

export const getRpc = () => (rpc ??= createRetryingRpc(`${window.location.origin}/api/rpc`));
export const getJupiter = () =>
  (jupiter ??= createJupiterClient({
    buildUrl: '/api/jupiter/build',
    tokensUrl: '/api/jupiter/tokens',
    labelsUrl: '/api/jupiter/labels',
  }));
