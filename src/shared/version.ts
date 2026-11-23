/**
 * 运行时版本号的最小解析：只取后面兼容性判定要用的四段。
 * 不做语义化版本比较——比较一律交给宿主的 evaluatePluginCompatibility。
 */
export interface RuntimeVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标签（`0.2.2-rc.5` → `rc.5`）；正式版为 null */
  pre: string | null
}

export function parseRuntime(version: string): RuntimeVersion {
  const withoutV = version.trim().replace(/^v/i, '')
  const withoutBuild = withoutV.split('+')[0] ?? ''
  const dash = withoutBuild.indexOf('-')
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)
  const pre = dash === -1 ? '' : withoutBuild.slice(dash + 1)
  const [major, minor, patch] = core.split('.').map((part) => Number.parseInt(part, 10))
  return {
    major: major ?? Number.NaN,
    minor: minor ?? Number.NaN,
    patch: patch ?? Number.NaN,
    pre: pre === '' ? null : pre,
  }
}
