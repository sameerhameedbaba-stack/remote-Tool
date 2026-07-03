import type { Config } from "tailwindcss";

// Semantic color layer — every value resolves to a CSS variable defined in
// app/globals.css, so the same utility works in dark and light themes.
const config: Config = {
  darkMode: ["class", '[data-theme="dark"]'],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        app: "var(--app)",
        surface: {
          DEFAULT: "var(--surface)",
          raised: "var(--surface-raised)",
          card: "var(--surface-card)",
          hover: "var(--surface-hover)",
        },
        fg: {
          DEFAULT: "var(--fg)",
          secondary: "var(--fg-secondary)",
          muted: "var(--fg-muted)",
        },
        line: {
          DEFAULT: "var(--line)",
          soft: "var(--line-soft)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          fg: "var(--accent-fg)",
          soft: "var(--accent-soft)",
        },
        info: { DEFAULT: "var(--info)", soft: "var(--info-soft)" },
        success: { DEFAULT: "var(--success)", soft: "var(--success-soft)" },
        warning: { DEFAULT: "var(--warning)", soft: "var(--warning-soft)" },
        danger: { DEFAULT: "var(--danger)", soft: "var(--danger-soft)" },
        neutral: { DEFAULT: "var(--neutral)", soft: "var(--neutral-soft)" },
        ring: "var(--ring)",
      },
      fontFamily: {
        // Premium system stack: SF Pro on macOS, Segoe UI on Windows, Roboto on
        // Linux/Android — no web-font fetch, so the build stays hermetic.
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      boxShadow: {
        "elev-1": "var(--shadow-1)",
        "elev-2": "var(--shadow-2)",
        pop: "var(--shadow-pop)",
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "1rem",
      },
      transitionTimingFunction: {
        // Calm, Apple-like easing.
        premium: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-in-right": {
          from: { transform: "translateX(16px)", opacity: "0" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
        "scale-in": {
          from: { transform: "scale(0.98)", opacity: "0" },
          to: { transform: "scale(1)", opacity: "1" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        "pulse-ring": {
          "0%": { boxShadow: "0 0 0 0 var(--tw-shadow-color, rgba(55,194,107,0.5))" },
          "70%": { boxShadow: "0 0 0 6px rgba(55,194,107,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(55,194,107,0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 160ms ease-out",
        "slide-in-right": "slide-in-right 200ms cubic-bezier(0.22,1,0.36,1)",
        "scale-in": "scale-in 140ms cubic-bezier(0.22,1,0.36,1)",
        "pulse-ring": "pulse-ring 2s ease-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
