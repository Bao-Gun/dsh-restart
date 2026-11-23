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
})
