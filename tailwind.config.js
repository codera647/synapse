/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./pages/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#050509",
        surface: "#0b0b12",
        surfaceAlt: "#141421",
        accent: {
          100: "#E9D5FF",
          200: "#C4B5FD",
          300: "#A855F7",
          400: "#7C3AED",
          500: "#6D28D9",
          600: "#5B21B6",
        },
        muted: "#6B7280",
      },
      boxShadow: {
        soft: "0 18px 45px rgba(0,0,0,0.60)",
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
      },
    },
  },
  plugins: [],
};
