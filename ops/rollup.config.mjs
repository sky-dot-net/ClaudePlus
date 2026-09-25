import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Rollup configuration of the development build: every module under src/ joined into one
 * immediately-invoked userscript in import order, with all documentation kept and the userscript
 * metadata block from src/header.js on top.
 */
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export default {
  input: `${repositoryRoot}src/main.js`,
  output: {
    file: `${repositoryRoot}build/dev/ClaudePlus.js`,
    format: 'iife',
    banner: readFileSync(`${repositoryRoot}src/header.js`, 'utf8').trim(),
  },
};
