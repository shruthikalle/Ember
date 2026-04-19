/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'trading-bg': '#0a0b0f',
        'trading-surface': '#12141a',
        'trading-border': '#1e2128',
        'trading-accent': '#00ffa3',
        'trading-accent-blue': '#00a6ff',
        'trading-text': '#e5e7eb',
        'trading-text-dim': '#9ca3af',
      },
    },
  },
  plugins: [],
}
