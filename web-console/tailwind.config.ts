import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // MSP-console dark palette. Kept as CSS-var-free tokens for simplicity.
        surface: {
          950: "#0a0e17",
          900: "#0f1420",
          850: "#141b2b",
          800: "#1a2234",
          700: "#232d43",
          600: "#2e3a54",
        },
        accent: {
          400: "#4fa3ff",
          500: "#2b8bff",
          600: "#1c6fe0",
        },
      },
    },
  },
  plugins: [],
};

export default config;
