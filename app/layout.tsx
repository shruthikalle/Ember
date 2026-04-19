import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ember — Trade at the speed of thought',
  description: 'Natural-language trading for onchain markets. Describe the trade in plain English — swap, perp, or predict across Base, Solana, Hyperliquid, and Polymarket. Non-custodial, you sign every transaction.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" style={{ colorScheme: 'dark', background: '#09090b' }}>
      <head>
        <meta name="base:app_id" content="6998370a6768b2f53f686a2c" />
        <meta name="color-scheme" content="dark" />
        <meta name="theme-color" content="#09090b" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Instrument+Serif&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ background: '#09090b', color: '#f5f5f7' }}>{children}</body>
    </html>
  );
}
