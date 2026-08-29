import globals from 'globals';
import nextPlugin from 'eslint-config-next';
import base from './base.js';

export default [
  ...base,
  ...(Array.isArray(nextPlugin) ? nextPlugin : [nextPlugin]),
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
];
