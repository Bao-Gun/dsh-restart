import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { computeFingerprint, isStale, readLast, writeLast } from '../src/server/last'
import type { LastRecord, PrecheckResult } from '../src/shared/types'

let dir = ''
/** 本轮建过的所有临时目录，afterAll 再兜底清一次 */
const createdDirs: string[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-restart-last-'))
  createdDirs.push(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

afterAll(async () => {
  // 双保险：某个用例的 afterEach 被中断/跳过时，也不把 tmpdir 留在机器上
  await Promise.all(createdDirs.map((created) => rm(created, { recursive: true, force: true })))
})

async function seedLock(content = 'lockfileVersion: 9\n') {
  await writeFile(join(dir, 'pnpm-lock.yaml'), content)
}

async function seedLast(raw: string) {
  await writeFile(join(dir, 'last.json'), raw)
}

describe('computeFingerprint', () => {
  it('同一份 lock 与同一个版本得到同一个 16 位十六进制指纹', async () => {
    await seedLock()

    const first = await computeFingerprint(dir, '0.2.2-rc.5')
    const second = await computeFingerprint(dir, '0.2.2-rc.5')

    expect(first).toMatch(/^[0-9a-f]{16}$/)
    expect(second).toBe(first)
  })

  it('lock 内容变了指纹就变', async () => {
    await seedLock('lockfileVersion: 9\n')
    const before = await computeFingerprint(dir, '1.0.0')

    await seedLock('lockfileVersion: 9\npackages: {}\n')
    const after = await computeFingerprint(dir, '1.0.0')

    expect(after).not.toBe(before)
  })

  it('dsh 版本变了指纹就变', async () => {
    await seedLock()

    const old = await computeFingerprint(dir, '0.2.2-rc.5')
    const next = await computeFingerprint(dir, '0.3.0')

    expect(next).not.toBe(old)
  })

  it('拿不到 dsh 版本时返回 null，不抛', async () => {
    await seedLock()

    expect(await computeFingerprint(dir, null)).toBeNull()
    expect(await computeFingerprint(dir, '   ')).toBeNull()
  })

  it('lock 文件不存在时返回 null，不抛', async () => {
    expect(await computeFingerprint(join(dir, 'missing'), '1.0.0')).toBeNull()
  })
})

describe('readLast', () => {
  it('文件不存在返回空记录', async () => {
    expect(await readLast(dir)).toEqual({})
  })

  it('空文件返回空记录', async () => {
    await seedLast('')

    expect(await readLast(dir)).toEqual({})
  })

  it('半截 JSON 返回空记录，不抛', async () => {
    await seedLast('{')

    expect(await readLast(dir)).toEqual({})
  })

  it('last.json 是目录时返回空记录，不抛', async () => {
    await mkdir(join(dir, 'last.json'))

    expect(await readLast(dir)).toEqual({})
  })

  it.skipIf(process.getuid?.() === 0)('权限拒绝时返回空记录，不抛', async () => {
    const file = join(dir, 'last.json')
    await writeFile(file, '{"fingerprint":"0123456789abcdef"}')
    await chmod(file, 0o000)
    try {
      expect(await readLast(dir)).toEqual({})
    } finally {
      await chmod(file, 0o600)
    }
  })

  it('schema 不符返回空记录', async () => {
    await seedLast('{"fingerprint": 42, "baseline": ["x"]}')
    expect(await readLast(dir)).toEqual({})

    await seedLast('[]')
    expect(await readLast(dir)).toEqual({})

    await seedLast('"just a string"')
    expect(await readLast(dir)).toEqual({})
  })

  it('合法记录原样读回（含失败项细节）', async () => {
    const record: LastRecord = {
      fingerprint: '0123456789abcdef',
      baseline: ['external-a', 'external-b'],
      precheck: {
        at: '2026-11-23T12:00:00.000Z',
        ok: false,
        fingerprint: '0123456789abcdef',
        failures: [
          {
            plugin: 'broken-plugin',
            kind: 'compat',
            message: 'engines.dsh 不满足',
            expected: '>=0.3.0',
            actual: '0.2.2-rc.5',
          },
        ],
        durationMs: 1234,
      },
      restart: { at: '2026-11-23T12:05:00.000Z', port: 3080 },
    }
    await seedLast(JSON.stringify(record))

    expect(await readLast(dir)).toEqual(record)
  })

  it('忽略未知字段，不因此判为 schema 不符', async () => {
    await seedLast('{"fingerprint":"0123456789abcdef","futureField":true}')

    expect(await readLast(dir)).toEqual({ fingerprint: '0123456789abcdef' })
  })
})

describe('writeLast', () => {
  it('写进去能读回来', async () => {
    await writeLast(dir, { fingerprint: '0123456789abcdef' })

    expect(await readLast(dir)).toEqual({ fingerprint: '0123456789abcdef' })
  })

  it('合并写只覆盖 patch 里的键', async () => {
    await writeLast(dir, { fingerprint: 'a1b2c3d4e5f60718', baseline: ['x'] })
    await writeLast(dir, {
      precheck: {
        at: '2026-11-23T12:00:00.000Z',
        ok: true,
        fingerprint: 'a1b2c3d4e5f60718',
        failures: [],
        durationMs: 10,
      },
    })

    const record = await readLast(dir)
    expect(record.fingerprint).toBe('a1b2c3d4e5f60718')
    expect(record.baseline).toEqual(['x'])
    expect(record.precheck?.ok).toBe(true)
  })

  it('同键再写以新的为准', async () => {
    await writeLast(dir, { fingerprint: 'aaaaaaaaaaaaaaaa' })
    await writeLast(dir, { fingerprint: 'bbbbbbbbbbbbbbbb' })

    expect((await readLast(dir)).fingerprint).toBe('bbbbbbbbbbbbbbbb')
  })

  it('目录不存在时自己建，且不留下 .tmp 文件', async () => {
    const nested = join(dir, 'nested', 'deeper')

    await writeLast(nested, { baseline: [] })

    expect((await readLast(nested)).baseline).toEqual([])
    expect((await readdir(nested)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('并发写多个 patch 不丢键', async () => {
    await Promise.all([
      writeLast(dir, { fingerprint: '0123456789abcdef' }),
      writeLast(dir, { baseline: ['x'] }),
      writeLast(dir, { restart: { at: '2026-11-23T12:05:00.000Z', port: 3080 } }),
    ])

    const record = await readLast(dir)
    expect(record.fingerprint).toBe('0123456789abcdef')
    expect(record.baseline).toEqual(['x'])
    expect(record.restart).toEqual({ at: '2026-11-23T12:05:00.000Z', port: 3080 })
  })

  it('重写后只保留 schema 字段，未知字段被丢弃', async () => {
    await seedLast('{"fingerprint":"0123456789abcdef","futureField":true}')

    await writeLast(dir, { baseline: ['x'] })

    const raw: unknown = JSON.parse(await readFile(join(dir, 'last.json'), 'utf8'))
    expect(raw).toEqual({ fingerprint: '0123456789abcdef', baseline: ['x'] })
  })
})

describe('顶层 fingerprint 契约', () => {
  const at = '2026-11-23T12:00:00.000Z'
  function precheck(fingerprint: string): PrecheckResult {
    return { at, ok: true, fingerprint, failures: [], durationMs: 1 }
  }

  it('显式写 fingerprint 后 readLast→isStale 为 false', async () => {
    await writeLast(dir, {
      precheck: precheck('0123456789abcdef'),
      fingerprint: '0123456789abcdef',
    })

    expect(isStale(await readLast(dir), '0123456789abcdef')).toBe(false)
  })

  it('只写 precheck 时保留已有的顶层 fingerprint，不抹掉', async () => {
    await writeLast(dir, { fingerprint: '0123456789abcdef' })
    await writeLast(dir, { precheck: precheck('0123456789abcdef') })

    const record = await readLast(dir)
    expect(record.fingerprint).toBe('0123456789abcdef')
    expect(isStale(record, '0123456789abcdef')).toBe(false)
  })
})

describe('isStale', () => {
  it('指纹相同不算过期', () => {
    expect(isStale({ fingerprint: 'a' }, 'a')).toBe(false)
  })

  it('指纹不同算过期', () => {
    expect(isStale({ fingerprint: 'a' }, 'b')).toBe(true)
  })

  it('记录里没有指纹算过期', () => {
    expect(isStale({}, 'b')).toBe(true)
  })

  it('当前指纹取不到（null）算过期', () => {
    expect(isStale({ fingerprint: 'a' }, null)).toBe(true)
  })
})
