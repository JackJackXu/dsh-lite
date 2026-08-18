module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parserOptions: { ecmaVersion: 2022 },
  rules: {
    // The createWindow `win` regression was exactly this class of bug:
    // referencing an undeclared name. no-undef catches it at CI time.
    'no-undef': 'error',
    'no-unused-vars': 'warn',
  },
};
