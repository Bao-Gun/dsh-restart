import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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

/** 容错读：文件不存在、空文件、半截 JSON、schema 不符，一律返回空记录。 */
export async function readLast(dir: string): Promise<LastRecord> {
  try {
    const raw = await readFile(join(dir, LAST_FILE), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return validateRecord(parsed) ?? {}
  } catch {
    return {}
  }
}

/** 合并写：只覆盖 patch 里显式给出的键，其余保留。先写 .tmp 再 rename，避免读到半截文件。 */
export async function writeLast(dir: string, patch: Partial<LastRecord>): Promise<void> {
  const merged = await readLast(dir)

  if (patch.fingerprint !== undefined) merged.fingerprint = patch.fingerprint
  if (patch.baseline !== undefined) merged.baseline = patch.baseline
  if (patch.precheck !== undefined) merged.precheck = patch.precheck
  if (patch.restart !== undefined) merged.restart = patch.restart

  await mkdir(dir, { recursive: true })
  const file = join(dir, LAST_FILE)
  // 并发写时各写各的临时文件，rename 是原子的，读方永远看不到半截 JSON
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/** 记录里没有指纹、指纹不同、或当前指纹取不到，都算过期。 */
export function isStale(record: LastRecord, fingerprint: string | null): boolean {
  if (!fingerprint) return true
  return record.fingerprint !== fingerprint
}
