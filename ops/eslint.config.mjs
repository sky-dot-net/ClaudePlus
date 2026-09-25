import jsdoc from 'eslint-plugin-jsdoc';

/**
 * Node types that must carry a JSDoc block: classes, methods, class fields, functions and
 * module-level constants other than CommonJS imports, exported or not.
 * @type {string[]}
 */
const documentedContexts = [
  'ClassDeclaration',
  'MethodDefinition',
  'PropertyDefinition',
  'FunctionDeclaration',
  'Program > VariableDeclaration:not(:has(CallExpression[callee.name="require"]))',
  'ExportNamedDeclaration[declaration.type="VariableDeclaration"]',
];

/**
 * Browser globals the userscript uses.
 * @type {Record<string, string>}
 */
const browserGlobals = Object.fromEntries([
  'AbortController', 'Blob', 'CompressionStream', 'DOMException', 'Event', 'File', 'FormData', 'Intl', 'Response',
  'TextDecoderStream', 'TextEncoder', 'URL', 'URLSearchParams', 'cancelAnimationFrame', 'clearInterval', 'clearTimeout',
  'console', 'crypto', 'document', 'fetch', 'history', 'indexedDB', 'localStorage', 'location', 'navigator',
  'requestAnimationFrame', 'setInterval', 'setTimeout', 'window',
].map(name => [name, 'readonly']));

/**
 * Node.js globals the smoke tests and the ops configurations use.
 * @type {Record<string, string>}
 */
const nodeGlobals = Object.fromEntries(['Buffer', 'URL', 'module', 'process', 'require'].map(name => [name, 'readonly']));

/**
 * Browser globals used by the smoke tests' functions that run inside the page.
 * @type {Record<string, string>}
 */
const pageGlobals = Object.fromEntries(['ClipboardEvent', 'DataTransfer', 'DragEvent', 'getComputedStyle'].map(name => [name, 'readonly']));

/**
 * Rules shared by the userscript and the smoke tests: full JSDoc coverage, no ordinary comments,
 * one export per module, shallow code and descriptive names.
 * @type {import('eslint').Linter.RulesRecord}
 */
const qualityRules = {
  'claudePlus/only-jsdoc-comments': 'error',
  'claudePlus/single-export': 'error',
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'after-used' }],
  'no-unused-private-class-members': 'error',
  complexity: ['error', { max: 5 }],
  'max-depth': ['error', 2],
  'max-nested-callbacks': ['error', 2],
  'id-length': ['error', { min: 3, exceptions: ['id', 'ok'], properties: 'always' }],
  'jsdoc/require-jsdoc': ['error', { require: { ClassDeclaration: true, MethodDefinition: true, FunctionDeclaration: true }, contexts: documentedContexts, checkConstructors: true, checkGetters: true, checkSetters: true }],
  'jsdoc/require-description': ['error', { contexts: documentedContexts }],
  'jsdoc/require-param': ['error', { checkConstructors: true, checkGetters: true, checkSetters: true, contexts: ['MethodDefinition', 'FunctionDeclaration', 'PropertyDefinition > ArrowFunctionExpression'] }],
  'jsdoc/require-param-description': 'error',
  'jsdoc/require-param-type': 'error',
  'jsdoc/require-param-name': 'error',
  'jsdoc/check-param-names': 'error',
  'jsdoc/require-returns': ['error', { forceRequireReturn: true, forceReturnsWithAsync: true, checkGetters: true, contexts: ['MethodDefinition:not([kind="constructor"]):not([kind="set"])', 'FunctionDeclaration', 'PropertyDefinition > ArrowFunctionExpression'] }],
  'jsdoc/require-returns-description': 'error',
  'jsdoc/require-returns-type': 'error',
  'jsdoc/require-yields': 'error',
  'jsdoc/require-throws': 'error',
  'jsdoc/check-tag-names': 'error',
};

/**
 * Rule allowing JSDoc blocks as the only comments, so no ordinary comment can go stale next to
 * changed code.
 * @type {import('eslint').Rule.RuleModule}
 */
const onlyJsdocComments = {
  meta: { type: 'suggestion', schema: [], messages: { ordinaryComment: 'Only JSDoc comments (/** ... */) are allowed.' } },

  /**
   * Reports every comment that is not a JSDoc block.
   * @param {import('eslint').Rule.RuleContext} context Rule context.
   * @returns {import('eslint').Rule.RuleListener} The listener checking the whole file.
   */
  create(context) {
    return {
      Program() {
        context.sourceCode.getAllComments()
          .filter(comment => comment.type !== 'Block' || !comment.value.startsWith('*'))
          .forEach(comment => context.report({ loc: comment.loc, messageId: 'ordinaryComment' }));
      },
    };
  },
};

/**
 * Rule allowing at most one exported class, function, constant or typedef per file.
 * @type {import('eslint').Rule.RuleModule}
 */
const singleExport = {
  meta: { type: 'suggestion', schema: [], messages: { tooManyExports: 'A module exports exactly one thing; move this export into its own file.' } },

  /**
   * Reports every export after the first one.
   * @param {import('eslint').Rule.RuleContext} context Rule context.
   * @returns {import('eslint').Rule.RuleListener} The listener checking the whole file.
   */
  create(context) {
    return {
      Program(program) {
        program.body
          .filter(statement => statement.type === 'ExportDefaultDeclaration' || (statement.type === 'ExportNamedDeclaration' && (statement.declaration || statement.specifiers.length)))
          .slice(1)
          .forEach(statement => context.report({ node: statement, messageId: 'tooManyExports' }));
      },
    };
  },
};

/**
 * Rule allowing at most one module.exports property in a CommonJS file.
 * @type {import('eslint').Rule.RuleModule}
 */
const singleCommonJsExport = {
  meta: { type: 'suggestion', schema: [], messages: { tooManyExports: 'A module exports exactly one thing; move this export into its own file.' } },

  /**
   * Reports a module.exports object literal with more than one property.
   * @param {import('eslint').Rule.RuleContext} context Rule context.
   * @returns {import('eslint').Rule.RuleListener} The listener checking module.exports assignments.
   */
  create(context) {
    return {
      'AssignmentExpression[left.object.name="module"][left.property.name="exports"] > ObjectExpression'(exported) {
        exported.properties.slice(1).forEach(property => context.report({ node: property, messageId: 'tooManyExports' }));
      },
    };
  },
};

/**
 * The project's own rules.
 * @type {import('eslint').ESLint.Plugin}
 */
const claudePlusPlugin = { rules: { 'only-jsdoc-comments': onlyJsdocComments, 'single-export': singleExport, 'single-commonjs-export': singleCommonJsExport } };

/**
 * ESLint configuration of the userscript sources (ES modules), the smoke tests (CommonJS) and
 * the build and lint configurations in ops/.
 * @type {import('eslint').Linter.Config[]}
 */
export default [
  {
    files: ['src/**/*.js'],
    ignores: ['src/header.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: browserGlobals },
    plugins: { jsdoc, claudePlus: claudePlusPlugin },
    rules: qualityRules,
  },
  {
    files: ['tests/**/*.cjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...browserGlobals, ...pageGlobals, ...nodeGlobals } },
    plugins: { jsdoc, claudePlus: claudePlusPlugin },
    rules: { ...qualityRules, 'claudePlus/single-commonjs-export': 'error' },
  },
  {
    files: ['ops/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: nodeGlobals },
    plugins: { jsdoc, claudePlus: claudePlusPlugin },
    rules: qualityRules,
  },
];
