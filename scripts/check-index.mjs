#!/usr/bin/env node
/**
 * 索引自检：site/index.json 里每个版本都必须指向「产物真的在仓库里」的提交。
 *
 * 为什么要有它：git 源装的是索引固定 commit 的仓库内容，装完直接加载 lib/index.js，
 * 不跑 prepare、不构建。索引一旦指向旧提交（或者产物压根没提交），用户装到的是旧代码、
 * 甚至起不来，而市场 UI 上一切看起来都正常。这个脚本把这件事在 check.sh 里变成红灯。
 *
 * 判定分两层：
 *   verifyIndex        —— 纯函数（版本号对齐、commit 形状、icon 路径安全），可单测；
 *   commitHasArtifacts —— 脚本外壳，真的去问 git：该提交里确有产物，且与当前提交的产物一致。
 * 只查「有」不够：旧索引 ddff340 里 lib/*.js 都在，但已是旧产物，正是要防的那种静默装旧码。
 *
 * 只使用 node: 内置模块，不引入第三方依赖，也不参与 tsc。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO_DIR, REQUIRED_ARTIFACTS } from './install.mjs'

/** 失败时给一条能照做的下一步：只有这一处措辞，别在别处复制。 */
export const GUIDANCE = '先 pnpm build 再提交 lib/，再 pnpm market:index'

/**
 * 图标路径只允许相对路径（按索引 URL 解析）或跨域 https 地址（市场文档允许）。
 * 绝对文件路径与 .. 在装的人机器上指向别处，一律挡下。
 */
function iconProblem(icon) {
  if (typeof icon !== 'string' || icon.trim() === '') return '缺失'
  if (icon.startsWith('https://')) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(icon)) return '不是 https 的绝对地址'
  if (icon.startsWith('/') || icon.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(icon)) return '是绝对路径'
  if (icon.split(/[\\/]/).includes('..')) return '含 ..'
  return null
}

/**
 * 纯函数：不读文件、不碰 git，产物是否存在由调用方注入。
 * 返回 { ok: true } 或 { ok: false, errors: [{ code, message }] }；一次把问题报全，不首错即停。
 */
export function verifyIndex(index, { packageVersion, commitHasArtifacts }) {
  const plugins = index && typeof index === 'object' ? index.plugins : undefined
  if (!Array.isArray(plugins) || plugins.length === 0) {
    return { ok: false, errors: [{ code: 'invalid-index', message: 'site/index.json 里没有 plugins 数组，市场一个插件也列不出来' }] }
  }

  const errors = []
  for (const plugin of plugins) {
    const name = (plugin && plugin.name) || '(未命名插件)'
    const problem = iconProblem(plugin && plugin.icon)
    if (problem !== null) {
      errors.push({
        code: 'invalid-icon',
        message: `索引里 ${name} 的 icon ${JSON.stringify(plugin && plugin.icon)} ${problem}；图标只能写相对路径或 https 地址`,
      })
    }

    const versions = plugin && plugin.versions
    if (!Array.isArray(versions) || versions.length === 0) {
      errors.push({ code: 'invalid-index', message: `索引里 ${name} 一个版本都没有，装了也没有可指认的提交` })
      continue
    }

    for (const version of versions) {
      const declared = version && version.version
      const commit = version && version.source && version.source.commit
      if (declared !== packageVersion) {
        errors.push({
          code: 'version-mismatch',
          message: `索引里 ${name} 的版本是 ${declared}，package.json 是 ${packageVersion}：改过版本号就得重新生成索引`,
        })
      }
      if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
        errors.push({
          code: 'missing-artifacts',
          message: `索引 ${name}@${declared} 的 source.commit 不是 40 位小写 commit：${JSON.stringify(commit)}`,
        })
        continue
      }
      for (const artifact of REQUIRED_ARTIFACTS) {
        if (commitHasArtifacts(commit, artifact)) continue
        errors.push({
          code: 'missing-artifacts',
          message: `索引 ${name}@${declared} 指向的提交 ${commit} 里没有与当前产物一致的 ${artifact}（产物没提交，或索引指向旧提交）：装了会是旧代码或起不来`,
        })
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

function gitOk(args) {
  try {
    execFileSync('git', args, { cwd: REPO_DIR, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 产物「在」还不够：内容必须和当前提交一致，否则索引指的就是旧产物。 */
export function commitHasArtifacts(commit, path) {
  if (!gitOk(['cat-file', '-e', `${commit}:${path}`])) return false
  return gitOk(['diff', '--quiet', `${commit}:${path}`, `HEAD:${path}`])
}

export function run({ out = console.log, err = console.error } = {}) {
  const pkg = JSON.parse(readFileSync(join(REPO_DIR, 'package.json'), 'utf8'))
  const index = JSON.parse(readFileSync(join(REPO_DIR, 'site', 'index.json'), 'utf8'))
  const result = verifyIndex(index, { packageVersion: pkg.version, commitHasArtifacts })

  if (result.ok) {
    const entries = index.plugins.flatMap((plugin) =>
      (plugin.versions || []).map((version) => `${plugin.name}@${version.version} → ${String(version.source.commit).slice(0, 7)}`),
    )
    out(`✓ 索引自检通过：${entries.join('，')}`)
    return 0
  }

  for (const error of result.errors) err(`✗ [${error.code}] ${error.message}`)
  err(GUIDANCE)
  return 1
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  try {
    process.exitCode = run()
  } catch (error) {
    console.error(`✗ 索引自检没法开始：${error instanceof Error ? error.message : String(error)}`)
    console.error(GUIDANCE)
    process.exitCode = 1
  }
}
