import type { Config } from 'tailwindcss';

export default {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      keyframes: {
        deckSwitch: {
          '0%': { transform: 'translateX(16px) scale(0.96)', opacity: '0.7' },
          '60%': { transform: 'translateX(0) scale(1.01)' },
          '100%': { transform: 'translateX(0) scale(1)', opacity: '1' }
        }
      },
      animation: {
        'deck-switch': 'deckSwitch 500ms cubic-bezier(0.34, 1.56, 0.64, 1)'
      },
      colors: {
        border: 'hsl(240 5.9% 90%)',
        input: 'hsl(240 5.9% 90%)',
        ring: 'hsl(240 5% 64.9%)',
        background: 'hsl(0 0% 100%)',
        foreground: 'hsl(240 10% 3.9%)',
        primary: {
          DEFAULT: 'hsl(240 5.9% 10%)',
          foreground: 'hsl(0 0% 98%)'
        },
        muted: {
          DEFAULT: 'hsl(240 4.8% 95.9%)',
          foreground: 'hsl(240 3.8% 46.1%)'
        }
      }
    }
  },
  plugins: []
} satisfies Config;
