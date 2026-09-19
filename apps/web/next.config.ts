import type { NextConfig } from 'next';

// The Content-Security-Policy for pages is set per request, with a nonce, in proxy.ts (audit B-08).
// API responses are JSON (or images from /api/token-icon, which set their own CSP) under nosniff.
const config: NextConfig = {
  transpilePackages: ['@bound/core', '@bound/verifier', '@bound/solana', '@bound/jupiter'],
  poweredByHeader: false,
  reactStrictMode: true,
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
