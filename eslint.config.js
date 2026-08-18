// ESLint flat config (ESLint 9+). 目标：在 CI 抓住"引用未定义变量"这类回归
// （例如 createWindow 里 `win` 未声明的那个 bug）——node --check 测不出来。
// 全局变量直接用 globals 包（eslint 自带依赖）的 node 全集，别手写——
// 手写会漏（URL、setImmediate 都漏过）。
const globals = require('globals');

module.exports = [
  {
    files: ['main.js', 'scripts/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        // globals.node 的静态表不含它：mux-watcher 用全局 WebSocket（Node 22+ 内置）
        WebSocket: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
]
