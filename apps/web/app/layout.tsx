import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Served from Orientim's own origin (next/font), so the page's font-src stays 'self'.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
// Headings; code, the terminal and the small labels are set in mono.
const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-bricolage', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL('https://orientim.com'),
  title: 'Orientim — Protected swaps on Solana',
  description: 'Protected Solana swaps for AI agents and bots. The skill checks each transaction on your own RPC before signing; direct API bots must do the same.',
  openGraph: {
    title: 'Orientim — Protected swaps on Solana',
    description: 'Give your agent a safer way to swap with independent verification before signing.',
    url: 'https://orientim.com',
    siteName: 'Orientim',
    type: 'website',
  },
  // The image itself is app/opengraph-image.tsx and app/twitter-image.tsx.
  twitter: {
    card: 'summary_large_image',
    title: 'Orientim — Protected swaps on Solana',
    description: 'Let your agent trade without handing over its wallet.',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0c1117',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
