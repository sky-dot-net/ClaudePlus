import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of the repository root, with a trailing slash.
 * @type {string}
 */
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Rollup plugin turning an imported .css file into a module whose default export is the stylesheet text.
 * @type {import('rollup').Plugin}
 */
const cssAsText = {
  name: 'css-as-text',

  /**
   * Wraps a stylesheet into a JavaScript module and leaves every other module unchanged.
   * @param {string} code Source of the module.
   * @param {string} id Absolute path of the module.
   * @returns {?{code: string, map: null}} The wrapping module for a stylesheet, otherwise null.
   */
  transform(code, id) {
    return id.endsWith('.css') ? { code: `export default ${JSON.stringify(code)};`, map: null } : null;
  },
};

/**
 * Rollup configuration of the development build: bundles src/main.js with all its modules into one
 * readable userscript, keeping every JSDoc block, headed by the userscript metadata of src/header.js.
 * @type {import('rollup').RollupOptions}
 */
export default {
  input: `${repositoryRoot}src/main.js`,
  plugins: [cssAsText],
  output: {
    file: `${repositoryRoot}build/dev/ClaudePlus.js`,
    format: 'iife',
    banner: readFileSync(`${repositoryRoot}src/header.js`, 'utf8').trim(),
  },
};
