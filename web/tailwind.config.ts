import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        app: {
          bg: "#F6F5F1",
          sidebar: "#242622",
          surface: "#FFFFFF",
          "surface-subtle": "#F9F8F5",
          "surface-muted": "#F0EFEA",
          border: "#E5E4DE",
          "border-strong": "#D5D3CA",
          text: "#252722",
          "text-muted": "#777A73",
          "text-subtle": "#9B9E96",
          accent: "#52745B",
          "accent-hover": "#44624C",
          "accent-subtle": "#EDF2EE",
          olive: "#8A916A",
          "olive-subtle": "#F3F5EB",
        },
        status: {
          success: {
            bg: "#EEF3EE",
            text: "#3B6145",
            border: "#C8D7CA",
            dot: "#52745B",
          },
          warning: {
            bg: "#FAF4E8",
            text: "#8C631B",
            border: "#E9D8B4",
            dot: "#B58533",
          },
          danger: {
            bg: "#F9ECEB",
            text: "#872B28",
            border: "#E5BCB9",
            dot: "#A8423F",
          },
          neutral: {
            bg: "#F3F4F6",
            text: "#4B5563",
            border: "#E5E7EB",
            dot: "#777A73",
          },
        },
      },
      borderRadius: {
        sm: "4px",
        DEFAULT: "6px",
        md: "8px",
        lg: "10px",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "Courier New",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};

export default config;

