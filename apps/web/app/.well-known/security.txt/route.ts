import { LEGAL } from '@/lib/legal';

/**
 * RFC 9116: where to report a vulnerability. Served only once a security or support address is set;
 * until then there is no one to write to, and the file is not found.
 */
export function GET() {
  const email = LEGAL.securityEmail || LEGAL.supportEmail;
  if (!email) return new Response('Not found', { status: 404 });
  // A year ahead of the day it is served, as RFC 9116 asks, so it never expires while the site runs.
  const expires = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const body = [
    `Contact: mailto:${email}`,
    `Expires: ${expires}`,
    'Preferred-Languages: en',
    'Canonical: https://orientim.com/.well-known/security.txt',
    'Policy: https://orientim.com/security#report',
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
