import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client/index.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'lib',
  clean: true,
  splitting: false,
  sourcemap: true,
  // 运行期不引第三方依赖；宿主包也全量打进产物，装进 profile 后离线可用。
  noExternal: [/.*/],
})
