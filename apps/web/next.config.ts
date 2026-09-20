import type { NextConfig } from 'next';

// The Content-Security-Policy for pages is set per request, with a nonce, in proxy.ts (audit B-08).
// API responses are JSON (or images from /api/token-icon, which set their own CSP) under nosniff.
const config: NextConfig = {
  transpilePackages: ['@bound/core', '@bound/verifier', '@bound/solana', '@bound/jupiter'],
  poweredByHeader: false,
  reactStrictMode: true,
  // Every script tag carries the hash of the script it loads, so a browser refuses one that was
  // altered in transit or at the edge. Together with the per-request nonce this means the page can
  // only run the code that was built.
  experimental: { sri: { algorithm: 'sha384' } },
  // A build id that depends on the commit, not on the clock: two builds of the same source produce
  // the same output, which is what makes `tools/build-digest.ts` worth publishing.
  generateBuildId: () => process.env.BOUND_BUILD_ID ?? 'bound',
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        ],
      },
    ];
  },
};

export default config;
