import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { computeFingerprint, isStale, readLast, writeLast } from '../src/server/last'
import type { LastRecord } from '../src/shared/types'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-restart-last-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
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
