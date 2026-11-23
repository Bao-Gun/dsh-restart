#!/usr/bin/env node
// 生成 site/index.json —— 插件市场索引源（format 1）。
//
// 数据只有三处来源：package.json（name / version / engines.dsh）、下面的 plugin 常量
// （本地化标题与分类）、git HEAD（commit 与提交时间）。所以「发一版」永远是：
// 改版本号 → pnpm build → 提交 → pnpm market:index → 再提交 site/。
//
// 索引里的 commit 必须是「产物已经在仓库里」的那个提交，脚本自己不提交任何东西：
// 本地手动跑时指向当前 HEAD（所以要在 build 之后、提交之后跑）；CI 里在 checkout
// 出来的提交上重跑一次，线上索引就是线上代码本身。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

const REPOSITORY = 'https://github.com/Bao-Gun/dsh-restart'

// 展示信息只写在这里：索引的每个字段都要人工确认过一次，别让它从别处漂过来。
const SHOWCASE = {
  title: { en: 'Restart & Precheck', zh: '重启与预检' },
  description: {
    en: 'A restart button for dsh web that reruns startup checks on a cloned profile before it really restarts.',
    zh: '在 dsh web 侧栏加一颗「重启」按钮：先克隆 profile 试跑一遍，确认这堆插件还起得来，才真重启。',
  },
  icon: 'icons/dsh-restart.svg',
  author: 'Bao-Gun',
  category: 'interface',
  keywords: ['restart', 'precheck', 'reload'],
}

const metadata = {
  categories: { interface: { title: { en: 'Interface', zh: '界面' } } },
  labels: {},
  sortKeys: {},
}

const index = {
  format: 1,
  title: { en: 'Bao-Gun DSH plugins', zh: '包棍的 DSH 插件' },
  description: { en: 'Self-used DSH plugins, installable straight from this index.', zh: '自己用的一组 DSH 插件，从这个索引直接装。' },
  metadata,
  plugins: [
    {
      name: pkg.name,
      title: SHOWCASE.title,
      description: SHOWCASE.description,
      icon: SHOWCASE.icon,
      author: SHOWCASE.author,
      homepage: REPOSITORY,
      repository: { url: REPOSITORY },
      metadata: { category: SHOWCASE.category, keywords: SHOWCASE.keywords },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Number(git('log', '-1', '--format=%ct')),
          engines: { dsh: pkg.engines.dsh },
          source: { type: 'git', url: REPOSITORY + '.git', commit: git('rev-parse', 'HEAD') },
        },
      ],
    },
  ],
}

mkdirSync(join(root, 'site'), { recursive: true })
const target = join(root, 'site/index.json')
writeFileSync(target, JSON.stringify(index, undefined, 2) + '\n')

const version = index.plugins[0].versions[0]
console.log('索引: ' + target)
console.log('插件: ' + pkg.name + '@' + pkg.version + ' (' + version.source.commit.slice(0, 7) + ')')
console.log('安装 spec: git+' + version.source.url + '#' + version.source.commit)
console.log('提交前先确认 lib/*.js 已随代码提交，否则装下来跑不起来。')
