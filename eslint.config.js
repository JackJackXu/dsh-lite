// ESLint flat config (ESLint 9+). 目标：在 CI 抓住"引用未定义变量"这类回归
// （例如 createWindow 里 `win` 未声明的那个 bug）——node --check 测不出来。
module.exports = [
  {
    files: ['main.js', 'scripts/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node 环境内置
        require: 'readonly', module: 'readonly', process: 'readonly',
        __dirname: 'readonly', __filename: 'readonly', console: 'readonly',
        Buffer: 'readonly', setInterval: 'readonly', setTimeout: 'readonly',
        clearInterval: 'readonly', clearTimeout: 'readonly',
        // mux-watcher 用全局 WebSocket（Node 22+ 内置）
        WebSocket: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
]
