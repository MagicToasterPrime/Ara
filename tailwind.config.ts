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
        paper: "#F7F6F2",
        card: "#FCFBF9",
        pinned: "#F4EFE6",
        ink: "#1A1A1A",
        stone: "#6E6D68",
        border: "#DCDAD3",
        amber: "#D99B26",
        carmine: "#C83E4D",
        forest: "#3B7A57",
        slate: "#3D6B99",
        "badge-bg": "#E8F0F8",
        "badge-text": "#2B547E",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: {
        none: "0px",
        DEFAULT: "0px",
        sm: "0px",
        md: "0px",
        lg: "0px",
        xl: "0px",
        "2xl": "0px",
        full: "0px",
      },
      boxShadow: {
        none: "none",
        DEFAULT: "none",
        sm: "none",
        md: "none",
        lg: "none",
      },
    },
  },
  plugins: [],
};

export default config;
