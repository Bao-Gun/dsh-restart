/**
 * 克隆 profile 用的 cp 候选表：按平台从「首选」排到「兜底」，冒烟与安装脚本共用同一张表。
 *
 * - darwin：APFS clonefile（-c）优先；文件系统不支持 clonefile 时 cp 非 0 退出，退回真拷贝。
 * - linux：--reflink=auto 在 btrfs/xfs 上真 CoW，ext4 上由 coreutils 自动退化成整拷贝；
 *   老 coreutils / busybox 认不出 --reflink 时退回普通 -R。
 * - 其它平台：只给普通 -R。
 *
 * 绝不用硬链接（-l）：克隆出来的副本会与线上 profile 共享 inode，试跑写日志/auth 就写进了线上 profile。
 * 每条候选都带 -R：目录递归拷贝是这份表的前提，调用方只负责按顺序试。
 *
 * scripts/install.mjs 是纯 JS、不能 import 这个 TS 模块，那边有一份同样的表；
 * test/clone.test.ts 把两边钉在一起——改这张表必须同批改那边。
 */
export function cloneCandidates(platform: NodeJS.Platform, source: string, dest: string): string[][] {
  if (platform === 'darwin') {
    return [
      ['-c', '-R', source, dest],
      ['-R', source, dest],
    ]
  }
  if (platform === 'linux') {
    return [
      ['--reflink=auto', '-R', source, dest],
      ['-R', source, dest],
    ]
  }
  return [['-R', source, dest]]
}
