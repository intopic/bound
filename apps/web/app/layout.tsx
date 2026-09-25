import type { Metadata, Viewport } from 'next';
import { Inter, Manrope } from 'next/font/google';
import './globals.css';

// Served from Orientim's own origin (next/font), so the page's font-src stays 'self'.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL('https://orientim.com'),
  title: 'Orientim — Protected swaps on Solana',
  description: 'Swap Solana tokens without giving the swap program authority over the rest of your wallet. For people and AI agents.',
  openGraph: {
    title: 'Orientim — Protected swaps on Solana',
    description: 'The trade gets authority. Your wallet doesn’t.',
    url: 'https://orientim.com',
    siteName: 'Orientim',
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
    <html lang="en" className={`${inter.variable} ${manrope.variable}`}>
      <body>{children}</body>
    </html>
  );
}
