import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Nonce-based CSP for every page (audit B-08). The frontend holds the verifier, so injected script
 * must not run: only scripts carrying this request's nonce, and what they load ('strict-dynamic').
 * Images are limited to Bound's origin and data: URIs (token icons come through /api/token-icon),
 * which also closes images as a channel for sending data out. Styles keep 'unsafe-inline': CSS
 * cannot run code, and with img-src and connect-src closed it has no way to send anything out.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const dev = process.env.NODE_ENV === 'development';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
