import { describe, expect, it } from 'vitest'

import {
  acquirePrecheck,
  releasePrecheck,
  runPrecheckRun,
} from '../src/server/precheck'
import type { PrecheckIo, PrecheckOutcome, PrecheckTarget } from '../src/server/precheck'
import type { Failure, LastRecord } from '../src/shared/types'
import type { SmokeResult } from '../src/server/smoke'

const TARGET: PrecheckTarget = { dir: '/home/u/.dsh/profiles/web', name: 'web', home: '/home/u/.dsh' }
const FP = '0123456789abcdef'

function smoke(overrides: Partial<SmokeResult> = {}): SmokeResult {
  return { ok: true, health: true, failures: [], failedEntries: [], durationMs: 1, ...overrides }
}

/** 假 io：只实现 PrecheckIo，每个用例按需覆盖字段。 */
function fakeIo(overrides: Partial<PrecheckIo> = {}): PrecheckIo {
  const base: PrecheckIo = {
    now: () => new Date('2026-11-23T12:00:00.000Z'),
    readLast: async () => ({}),
    writeLast: async () => {},
    computeFingerprint: async () => FP,
    runtimeVersion: () => '0.2.2-rc.5',
    runDumpConfig: async () => [],
    readInstalled: async () => [],
    compatFailures: () => [],
    runSmoke: async () => smoke(),
    tmpRoot: '/tmp/dsh-restart-test/tmp',
    logDir: '/tmp/dsh-restart-test/log',
  }
  return { ...base, ...overrides }
}

describe('runPrecheckRun', () => {
  it('通过时写 precheck + baseline + fingerprint，并返回 saved: true', async () => {
    const written: Array<Partial<LastRecord>> = []
    const stages: string[] = []
    const outcome = await runPrecheckRun(
      fakeIo({
        writeLast: async (_dir, patch) => {
          written.push(patch)
        },
      }),
      TARGET,
      { onStage: (stage) => stages.push(stage.stage) },
    )
    expect(stages).toEqual(['config', 'compat', 'boot'])
    expect(outcome).toMatchObject({ ok: true, saved: true, cancelled: false })
    expect(written).toHaveLength(1)
    expect(written[0]?.baseline).toEqual([])
    expect(written[0]?.fingerprint).toBe(FP)
    expect(written[0]?.precheck).toMatchObject({ ok: true, fingerprint: FP, failures: [] })
  })

  it('判红时只写 precheck + fingerprint，baseline 不动', async () => {
    const written: Array<Partial<LastRecord>> = []
    const outcome = await runPrecheckRun(
      fakeIo({
        runSmoke: async () =>
          smoke({ ok: false, health: false, failures: [{ kind: 'boot', message: '起不来' }] }),
        writeLast: async (_dir, patch) => {
          written.push(patch)
        },
      }),
      TARGET,
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.saved).toBe(true)
    expect(written).toHaveLength(1)
    expect(written[0]?.baseline).toBeUndefined()
    expect(written[0]?.precheck).toMatchObject({ ok: false })
  })

  it('取消后不写盘，outcome 带 cancelled 和已跑完的 smoke 字段', async () => {
    let smoked = false
    let writes = 0
    const stages: string[] = []
    const outcome = await runPrecheckRun(
      fakeIo({
        runSmoke: async () => {
          smoked = true
          return smoke({ failedEntries: ['old'] })
        },
        writeLast: async () => {
          writes += 1
        },
      }),
      TARGET,
      { onStage: (stage) => stages.push(stage.stage), isCancelled: () => smoked },
    )
    expect(outcome).toMatchObject({
      ok: false,
      saved: false,
      cancelled: true,
      entries: ['old'],
      health: true,
    })
    expect(outcome.fingerprint).toBeNull()
    expect(writes).toBe(0)
    // 取消发生在 boot 结论发出之前，交给调用方自己补 cancelled 行。
    expect(stages).toEqual(['config', 'compat'])
  })

  it('fingerprint 为 null 时不写盘，saved 为 false', async () => {
    let writes = 0
    const outcome = await runPrecheckRun(
      fakeIo({
        computeFingerprint: async () => null,
        writeLast: async () => {
          writes += 1
        },
      }),
      TARGET,
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.saved).toBe(false)
    expect(outcome.fingerprint).toBeNull()
    expect(writes).toBe(0)
  })

  it('第二次 acquirePrecheck 返回 false，release 之后能再取', () => {
    releasePrecheck()
    expect(acquirePrecheck()).toBe(true)
    expect(acquirePrecheck()).toBe(false)
    releasePrecheck()
    expect(acquirePrecheck()).toBe(true)
    releasePrecheck()
  })

  it('dump-config 抛错时给出快检执行失败，而不是整体异常', async () => {
    const outcome = await runPrecheckRun(
      fakeIo({
        runDumpConfig: async () => {
          throw new Error('spawn ENOENT')
        },
        runSmoke: async () => smoke(),
      }),
      TARGET,
    )
    const failure = outcome.failures[0] as Failure | undefined
    expect(failure?.kind).toBe('config')
    expect(failure?.message).toContain('spawn ENOENT')
  })

  it('写盘失败时返回 error，不把异常抛给调用方', async () => {
    const outcome: PrecheckOutcome = await runPrecheckRun(
      fakeIo({
        writeLast: async () => {
          throw new Error('disk full')
        },
      }),
      TARGET,
    )
    expect(outcome.saved).toBe(false)
    expect(outcome.error).toContain('disk full')
  })
})
