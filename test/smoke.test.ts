import { describe, expect, it } from 'vitest'

import { diffFailedEntries, parseNotActivated } from '../src/server/smoke'

/** 宿主 dsh-app-boot 的可选条目告警原文形状（activationDiagnostic）。 */
const WARNING_STDERR = [
  'dsh web: warning: 2 entries did not activate',
  'dsh-tools (dsh-tools): failed to import: Cannot find module \'x\'',
  'plugin-x (@scope/plugin-x): pending (waiting for services: loader, shell)',
  'dsh web: opening the default browser; pass --no-open to disable',
].join('\n')

/** 必需条目失败时宿主走 startupDiagnostic，形状与可选告警不同。 */
const STARTUP_FAILED_STDERR = [
  'dsh web: startup failed: 2 required plugins did not activate',
  '',
  'Failed plugins (2):',
  '  alpha',
  '    Package: @scope/alpha',
  '    failed to import: boom',
  '  beta (required)',
  '    Package: @scope/beta',
  '    failed to import: boom',
].join('\n')

describe('parseNotActivated', () => {
  it('从可选条目告警里抽出两个条目 id，忽略其它 warning', () => {
    expect(parseNotActivated(WARNING_STDERR)).toEqual(['dsh-tools', 'plugin-x'])
  })

  it('兼容必需条目失败的 startupDiagnostic 块，并去掉 (required) 标记', () => {
    expect(parseNotActivated(STARTUP_FAILED_STDERR)).toEqual(['alpha', 'beta'])
  })

  it('同一个条目出现多次只保留第一次', () => {
    const stderr = [
      'dsh web: warning: 2 entries did not activate',
      'dup (pkg): failed to import: boom',
      'dup (pkg): failed to import: boom',
    ].join('\n')

    expect(parseNotActivated(stderr)).toEqual(['dup'])
  })

  it('没有 did not activate 标记时不误抓普通告警里的括号行', () => {
    const stderr = [
      'dsh: [/tmp/profile/cordis.patch.yml] patch: entry "mcp-connector" not found',
      'dsh web: listening on 127.0.0.1 over plain HTTP',
      'some (thing): not an activation diagnostic',
    ].join('\n')

    expect(parseNotActivated(stderr)).toEqual([])
  })

  it('空串与只有换行的串返回空数组', () => {
    expect(parseNotActivated('')).toEqual([])
    expect(parseNotActivated('\n\n')).toEqual([])
  })
})

describe('diffFailedEntries', () => {
  it('当前比基线多出的条目算 added', () => {
    expect(diffFailedEntries(['a', 'b'], ['b'])).toEqual({ added: ['a'], removed: [] })
  })

  it('基线和当前都空时两边都空', () => {
    expect(diffFailedEntries([], [])).toEqual({ added: [], removed: [] })
  })

  it('基线里有、这次没失败的条目算 removed（仅展示用，不阻断）', () => {
    expect(diffFailedEntries(['b'], ['a', 'b'])).toEqual({ added: [], removed: ['a'] })
  })

  it('两边都去重，并保持各自原有顺序', () => {
    expect(diffFailedEntries(['b', 'a', 'b'], ['a', 'a'])).toEqual({
      added: ['b'],
      removed: [],
    })
    expect(diffFailedEntries(['a'], ['b', 'b', 'c'])).toEqual({
      added: ['a'],
      removed: ['b', 'c'],
    })
  })
})
