import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "drizzle/**",
      "projects/**",
      "data/**",
      "screenshots/**",
      "test-results/**",
      "playwright-report/**",
      ".agents/**",
      ".claude/**",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    // Dev/verification scripts and Playwright specs are plain CommonJS.
    files: ["scripts/**/*.js", "scripts/**/*.mjs", "tests/**/*.js", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Pre-existing pattern across the UI; violations are being reworked
    // incrementally rather than mass-edited. New code should not add more.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default eslintConfig;
