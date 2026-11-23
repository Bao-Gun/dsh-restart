/**
 * 跨模块共享的类型。只放数据结构，不放实现，避免 server / client 互相 import。
 */

/** 一次预检里失败的一件事。三段快检（config / compat / boot）共用这个形状。 */
export interface Failure {
  /** 相关插件名；系统级失败（比如 dump-config 整体挂掉）不带 */
  plugin?: string
  kind: 'config' | 'compat' | 'boot'
  message: string
  expected?: string
  actual?: string
}

/** 最近一次预检的结果。 */
export interface PrecheckResult {
  /** 预检完成时刻（ISO 8601） */
  at: string
  ok: boolean
  /** 预检时算出的 profile 指纹，用来判断这条结果是否过期 */
  fingerprint: string
  failures: Failure[]
  durationMs: number
}

/** 最近一次重启的发起记录。 */
export interface RestartRecord {
  /** 重启发起的时刻（ISO 8601） */
  at: string
  /** 重启前 dsh web 的监听端口 */
  port: number
}

/**
 * `~/.dsh/dsh-restart/last.json` 的内容。
 * 每个字段都可能缺：没跑过预检、没重启过、或者文件坏了，都表现为空记录。
 */
export interface LastRecord {
  fingerprint?: string
  /** 上一次「通过」时试跑出来的未激活插件名单，冒烟时用来做差分 */
  baseline?: string[]
  precheck?: PrecheckResult
  restart?: RestartRecord
}
