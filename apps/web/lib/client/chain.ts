'use client';

import { createJupiterClient } from '@bound/jupiter';
import type { JupiterClient } from '@bound/jupiter';
import { createRetryingRpc } from '@bound/solana';
import type { SolanaRpc } from '@bound/solana';

// Every network call goes through Bound's own stateless API routes (D8): the browser never sees
// RPC credentials or the Jupiter API key.
let rpc: SolanaRpc | null = null;
let secondary: SolanaRpc | null = null;
let jupiter: JupiterClient | null = null;

export const getRpc = () => (rpc ??= createRetryingRpc(`${window.location.origin}/api/rpc`));
export const getSecondaryRpc = () => (secondary ??= createRetryingRpc(`${window.location.origin}/api/rpc-secondary`));
export const getJupiter = () =>
  (jupiter ??= createJupiterClient({
    buildUrl: '/api/jupiter/build',
    tokensUrl: '/api/jupiter/tokens',
    labelsUrl: '/api/jupiter/labels',
  }));
