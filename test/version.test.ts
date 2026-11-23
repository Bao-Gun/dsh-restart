import { describe, expect, it } from 'vitest'

import { parseRuntime } from '../src/shared/version'

describe('parseRuntime', () => {
  it('拆出带预发布标签的版本', () => {
    expect(parseRuntime('0.2.2-rc.5')).toEqual({
      major: 0,
      minor: 2,
      patch: 2,
      pre: 'rc.5',
    })
  })

  it('正式版没有预发布标签', () => {
    expect(parseRuntime('1.0.0').pre).toBeNull()
  })

  it('容忍 v 前缀，忽略 build metadata', () => {
    expect(parseRuntime('v0.2.2')).toEqual({ major: 0, minor: 2, patch: 2, pre: null })
    expect(parseRuntime('0.2.2+build.1')).toEqual({ major: 0, minor: 2, patch: 2, pre: null })
  })

  it.each(['0.2', 'abc', '', '1.x.0', '1.0.0-'])(
    '非法版本 %j 抛错（与宿主 dsh-app-boot 同语义）',
    (bad) => {
      expect(() => parseRuntime(bad)).toThrowError(
        new Error(
          `Invalid dsh runtime version: ${JSON.stringify(bad)}; expected a semantic version`,
        ),
      )
    },
  )
})
