import type { MetadataRoute } from 'next';

const PAGES = ['/', '/security', '/developers', '/status', '/terms', '/privacy'];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map(path => ({ url: `https://orientim.com${path === '/' ? '' : path}` }));
}
