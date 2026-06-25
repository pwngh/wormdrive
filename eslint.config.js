/**
 * @pwngh/wormdrive
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// Flat ESLint config. Deliberately small: tsc is still the primary static gate
// (strict + noUncheckedIndexedAccess); lint adds the few things types can't see —
// floating promises, dead bindings, `==`. Type-aware rules run only on the app
// TS (which tsconfig.json covers); tests and the plain-Node scripts/server lint
// without type info.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Flat-config array: each object is a layer matched by its `files` glob, and for a
 * given file the later matching layers win. `eslint.config.js` is linted as plain
 * Node because it matches only the `**\/*.mjs` + `eslint.config.js` layer and none
 * of the type-aware layers (whose globs are `src/**\/*.ts` and `vite.config.ts`),
 * so it never gets pulled into the type-aware service that only knows about the
 * app's tsconfig.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "public/**", ".idea/**"] },

  // App TypeScript — type-aware, so no-floating-promises (the headline rule) works.
  {
    files: ["src/**/*.ts", "vite.config.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: globals.browser,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },

  // Unit tests — TS, but outside tsconfig's include, so lint without type info.
  {
    files: ["test/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },

  // Plain-ESM Node: the signaling server, the build/dev scripts, and this config.
  {
    files: ["**/*.mjs", "eslint.config.js"],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: "module", globals: globals.node },
  },

  // The e2e harness runs functions inside the browser via page.evaluate, so it
  // legitimately references DOM globals (document, window) alongside Node's.
  {
    files: ["scripts/smoke-e2e.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
