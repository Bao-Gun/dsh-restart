import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { cloneCandidates } from '../src/server/clone'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const installUrl = pathToFileURL(join(repoRoot, 'scripts', 'install.mjs')).href

/** install.mjs 是纯 JS、不参与 tsc；用变量 URL 动态 import，避免 TS7016（与 test/install.test.ts 一致）。 */
async function loadInstall(): Promise<any> {
  return import(installUrl)
}

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'linux', 'freebsd', 'win32']

describe('克隆候选表', () => {
  it('darwin 先 APFS clonefile，再退回普通拷贝', () => {
    expect(cloneCandidates('darwin', 'a', 'b')).toEqual([
      ['-c', '-R', 'a', 'b'],
      ['-R', 'a', 'b'],
    ])
  })

  it('linux 先 reflink=auto，再退回普通拷贝', () => {
    const candidates = cloneCandidates('linux', 'a', 'b')
    expect(candidates[0]).toEqual(['--reflink=auto', '-R', 'a', 'b'])
    expect(candidates[1]).toEqual(['-R', 'a', 'b'])
  })

  it('其它平台只给普通拷贝', () => {
    expect(cloneCandidates('freebsd', 'a', 'b')).toEqual([['-R', 'a', 'b']])
    expect(cloneCandidates('win32', 'a', 'b')).toEqual([['-R', 'a', 'b']])
  })

  it('任何平台的候选都不用硬链接（-l / --link 会共享 inode，写进线上 profile）', () => {
    for (const platform of PLATFORMS) {
      const candidates = cloneCandidates(platform, 'a', 'b')
      expect(candidates.length).toBeGreaterThan(0)
      for (const args of candidates) {
        expect(args).toContain('-R')
        expect(args).not.toContain('-l')
        expect(args).not.toContain('--link')
      }
      // 最后一个候选必须是真拷贝兜底，前面失败才有退路
      expect(candidates[candidates.length - 1]).toEqual(['-R', 'a', 'b'])
    }
  })

  it('install.mjs 与 clone.ts 是同一张表（钉住两边，改表必须同批改）', async () => {
    const install = await loadInstall()
    for (const platform of ['darwin', 'linux', 'freebsd'] as NodeJS.Platform[]) {
      expect(install.cloneCandidateList('a', 'b', platform)).toEqual(cloneCandidates(platform, 'a', 'b'))
    }
  })

  it('cloneArgs 是候选表首选的薄包装（旧签名不炸）', async () => {
    const install = await loadInstall()
    for (const platform of PLATFORMS) {
      expect(install.cloneArgs('a', 'b', platform)).toEqual(cloneCandidates(platform, 'a', 'b')[0])
    }
  })
})
