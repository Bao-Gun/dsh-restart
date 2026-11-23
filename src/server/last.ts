import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Failure, LastRecord, PrecheckResult, RestartRecord } from '../shared/types'

const LAST_FILE = 'last.json'
const LOCK_FILE = 'pnpm-lock.yaml'
/** sha256 取前 16 位十六进制，够短又够区分 */
const FINGERPRINT_LENGTH = 16

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isFailure(value: unknown): value is Failure {
  if (!isPlainObject(value)) return false
  const { plugin, kind, message, expected, actual } = value
  return (
    isOptionalString(plugin) &&
    (kind === 'config' || kind === 'compat' || kind === 'boot') &&
    typeof message === 'string' &&
    isOptionalString(expected) &&
    isOptionalString(actual)
  )
}

function isPrecheck(value: unknown): value is PrecheckResult {
  if (!isPlainObject(value)) return false
  return (
    typeof value.at === 'string' &&
    typeof value.ok === 'boolean' &&
    typeof value.fingerprint === 'string' &&
    Array.isArray(value.failures) &&
    value.failures.every(isFailure) &&
    typeof value.durationMs === 'number' &&
    Number.isFinite(value.durationMs)
  )
}

function isRestart(value: unknown): value is RestartRecord {
  if (!isPlainObject(value)) return false
  return typeof value.at === 'string' && typeof value.port === 'number' && Number.isFinite(value.port)
}

/** 任何一项已知字段形状不对，整条记录都算坏；未知字段忽略，方便以后加字段。 */
function validateRecord(value: unknown): LastRecord | null {
  if (!isPlainObject(value)) return null

  const record: LastRecord = {}
  if ('fingerprint' in value) {
    if (typeof value.fingerprint !== 'string') return null
    record.fingerprint = value.fingerprint
  }
  if ('baseline' in value) {
    const baseline = value.baseline
    if (!Array.isArray(baseline) || baseline.some((item) => typeof item !== 'string')) return null
    record.baseline = baseline as string[]
  }
  if ('precheck' in value) {
    if (!isPrecheck(value.precheck)) return null
    record.precheck = value.precheck
  }
  if ('restart' in value) {
    if (!isRestart(value.restart)) return null
    record.restart = value.restart
  }
  return record
}

/**
 * profile 指纹：pnpm-lock.yaml 内容 + 当前 dsh 运行时版本。
 * 版本由调用方注入（测试不跑 dsh）；lock 读不到或版本拿不到都返回 null 表示「无法判定」，
 * 由 isStale 把 null 当作过期处理，绝不抛。
 */
export async function computeFingerprint(
  profileDir: string,
  dshVersion: string | null,
): Promise<string | null> {
  const version = dshVersion?.trim()
  if (!version) return null

  let lock: string
  try {
    lock = await readFile(join(profileDir, LOCK_FILE), 'utf8')
  } catch {
    return null
  }

  return createHash('sha256')
    .update(lock)
    .update('\u0000')
    .update(version)
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH)
}

/**
 * 容错读：文件不存在、空文件、半截 JSON、schema 不符，一律返回空记录。
 *
 * 只保留 `LastRecord` 里的四个字段：未知字段会被忽略，并在下一次 `writeLast` 时丢弃。
 * 这是有意选择（见报告 m4）——这个文件由本插件独占写，单版本运行；透传未知键会让
 * 「schema 校验」形同虚设，也让类型契约和磁盘内容不一致。
 */
export async function readLast(dir: string): Promise<LastRecord> {
  try {
    const raw = await readFile(join(dir, LAST_FILE), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return validateRecord(parsed) ?? {}
  } catch {
    return {}
  }
}

/** 写盘串行链：同一进程内的 read-modify-write 排队，避免两个 patch 各读到旧值、互相抹键。 */
let writeChain: Promise<void> = Promise.resolve()

function serializeWrite(task: () => Promise<void>): Promise<void> {
  const run = writeChain.then(task)
  // 一次写失败不能毒死后面的写：链只看「跑完了」，不看结果
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * 合并写：只覆盖 patch 里显式给出的键，其余保留。先写同目录 .tmp 再 rename，读者不会看到半截文件；
 * 进程内的并发写由 `serializeWrite` 排队，不会互相丢键。
 *
 * 顶层 `fingerprint` 是 `isStale` 的唯一依据：patch 没显式给就保持原值（带 precheck 时也不会被抹掉），
 * 显式给了才更新。预检通过时要显式传 `fingerprint`（Task 6 的计划已写明）。
 */
export function writeLast(dir: string, patch: Partial<LastRecord>): Promise<void> {
  return serializeWrite(() => writeLastNow(dir, patch))
}

async function writeLastNow(dir: string, patch: Partial<LastRecord>): Promise<void> {
  const merged = await readLast(dir)

  if (patch.fingerprint !== undefined) merged.fingerprint = patch.fingerprint
  if (patch.baseline !== undefined) merged.baseline = patch.baseline
  if (patch.precheck !== undefined) merged.precheck = patch.precheck
  if (patch.restart !== undefined) merged.restart = patch.restart

  await mkdir(dir, { recursive: true })
  const file = join(dir, LAST_FILE)
  // 并发写时各写各的临时文件，rename 是原子的，读方永远看不到半截 JSON
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  } catch (err) {
    // rename 失败（权限、磁盘满）时别把 .tmp 留在用户目录里
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/** 记录里没有指纹、指纹不同、或当前指纹取不到，都算过期。 */
export function isStale(record: LastRecord, fingerprint: string | null): boolean {
  if (!fingerprint) return true
  return record.fingerprint !== fingerprint
}
