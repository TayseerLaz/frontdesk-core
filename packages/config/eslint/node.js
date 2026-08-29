import globals from 'globals';
import base from './base.js';

export default [
  ...base,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
  },
];
