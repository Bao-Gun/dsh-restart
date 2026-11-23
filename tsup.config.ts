import { defineConfig } from 'tsup'

// 两份产物、两种运行环境：
// - 宿主入口 src/index.ts 跑在 Node 里，@deepseek-ai/* 是宿主提供的运行期依赖，
//   必须 external（否则内联 app-boot 后 getDshRuntimeVersion() 会读成插件自己的版本）。
// - 客户端入口 src/client/index.ts 跑在浏览器里，用 classic script 加载，
//   必须产出 iife，并用 banner/footer 把整个模块体包进宿主的 factory，
//   保证首行自注册、模块体副作用延迟到 materialize 时执行。
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outDir: 'lib',
    clean: true,
    splitting: false,
    sourcemap: true,
    external: [/^@deepseek-ai\//],
  },
  {
    entry: { client: 'src/client/index.ts' },
    format: ['iife'],
    platform: 'browser',
    target: 'es2022',
    outDir: 'lib',
    clean: false,
    splitting: false,
    sourcemap: true,
    outExtension: () => ({ js: '.js' }),
    globalName: '__dsh_restart_client',
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "dsh-restart", factory: (require) => {',
    },
    footer: {
      js: 'return __dsh_restart_client;\n} });',
    },
  },
])
