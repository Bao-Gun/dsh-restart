/**
 * 运行时版本号的最小解析：只取后面兼容性判定要用的四段。
 * 不做语义化版本比较——比较一律交给宿主的 evaluatePluginCompatibility。
 * 校验语义与宿主 dsh-app-boot 的 runtimeVersionOf 保持一致：非法输入直接抛错，
 * 不把 NaN 静默带进兼容性判断。
 */
export interface RuntimeVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标签（`0.2.2-rc.5` → `rc.5`）；正式版为 null */
  pre: string | null
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function parseRuntime(version: string): RuntimeVersion {
  // 与 semver 一致：容忍首尾空白、小写 v 前缀；build metadata 不参与解析。
  const withoutV = version.trim().replace(/^v/, '')
  const withoutBuild = withoutV.split('+')[0] ?? ''
  const match = SEMVER.exec(withoutBuild)
  if (match === null) {
    throw new Error(
      `Invalid dsh runtime version: ${JSON.stringify(version)}; expected a semantic version`,
    )
  }
  return {
    major: Number.parseInt(match[1] as string, 10),
    minor: Number.parseInt(match[2] as string, 10),
    patch: Number.parseInt(match[3] as string, 10),
    pre: match[4] ?? null,
  }
}
