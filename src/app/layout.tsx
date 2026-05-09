import type { Metadata, Viewport } from 'next';
import { Fraunces, Manrope, JetBrains_Mono, Cinzel, Cormorant_Garamond } from 'next/font/google';
import { ThemeBootstrap } from '@/components/theme-bootstrap';
import { PWARegister } from '@/components/pwa-register';
import './globals.css';

const fraunces = Fraunces({
  subsets: ['latin'],
  weight: 'variable',
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-display',
  axes: ['SOFT', 'WONK', 'opsz'],
});

const manrope = Manrope({
  subsets: ['latin'],
  weight: 'variable',
  display: 'swap',
  variable: '--font-body',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-jetbrains',
});

const cinzel = Cinzel({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-cinzel',
});

const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['500', '600'],
  style: ['italic'],
  display: 'swap',
  variable: '--font-numeral',
});

export const metadata: Metadata = {
  title: {
    default: 'Veridian Fabric — Forjar empresas autônomas',
    template: '%s · Veridian Fabric',
  },
  description: 'Veridian Fabric — chassi multi-tenant de auto-evolução de produto. Premissas, hipóteses e missões alimentadas por agentes de IA.',
  manifest: '/manifest.json',
  applicationName: 'Veridian Fabric',
  appleWebApp: {
    capable: true,
    title: 'Fabric',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    shortcut: '/favicon-32.png',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F2EFE3' },
    { media: '(prefers-color-scheme: dark)',  color: '#04100C' },
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const fontClasses = `${fraunces.variable} ${manrope.variable} ${jetbrains.variable} ${cinzel.variable} ${cormorant.variable}`;
  return (
    <html lang="pt-BR" className={fontClasses} suppressHydrationWarning>
      <head>
        <ThemeBootstrap />
      </head>
      <body>
        {children}
        <PWARegister />
      </body>
    </html>
  );
}
