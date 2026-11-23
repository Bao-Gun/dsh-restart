/**
 * 真进程集成测试：用临时假脚本顶替 dsh-daemon 与 dsh，验证 helper 的
 * spawn / 继承日志 fd / 真实 HTTP 探活 / 锁释放这条链路。
 *
 * 绝不碰真实的 dsh web（端口随机，命令路径被 DSH_RESTART_*_BIN 换成假脚本）。
 */
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { helperMain } from '../src/helper/restart'
import { RESTART_LOCK_NAME } from '../src/server/restart'

let dir = ''
let pidFile = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-restart-t5-proc-'))
  pidFile = join(dir, 'fake-web.pid')
})

afterEach(async () => {
  try {
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    if (Number.isInteger(pid) && pid > 0) await killIfAlive(pid)
  } catch {
    // 没有 pid 文件说明假 web 没起来。
  }
  await rm(dir, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
  return port
}

async function killIfAlive(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已经退出。
  }
}

async function writeScript(name: string, body: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, '#!/usr/bin/env node\n' + body + '\n')
  await chmod(path, 0o755)
  return path
}

/** 假 dsh 源码；withPluginStatus 为 false 时模拟「web 起来了但插件没加载」。 */
function fakeDshSource(withPluginStatus: boolean): string {
  const lines = [
    "import { createServer } from 'node:http'",
    "import { writeFileSync } from 'node:fs'",
    '',
    // 假 dsh 顺便当参数契约的哨兵：helper 必须用「--profile <name>」而不是
    // 位置参数 web + --profile（dsh 会报 select a profile only once）。
    'const argv = process.argv.slice(2)',
    "if (argv[0] !== '--profile' || argv[1] !== 'web') {",
    "  console.error('unexpected argv: ' + argv.join(' '))",
    '  process.exit(2)',
    '}',
    "if (!argv.includes('--no-open')) {",
    "  console.error('missing --no-open')",
    '  process.exit(3)',
    '}',
    "const index = process.argv.indexOf('--port')",
    'const port = Number(process.argv[index + 1])',
    'const server = createServer((req, res) => {',
    "  if (req.url === '/health') {",
    "    res.writeHead(200, { 'content-type': 'text/plain' })",
    "    res.end('ok')",
    '    return',
    '  }',
  ]
  if (withPluginStatus) {
    lines.push(
      "  if (req.url === '/dsh-restart/api/status') {",
      "    if (req.headers['x-dsh-restart'] !== '1') {",
      '      res.writeHead(400)',
      "      res.end('missing x-dsh-restart')",
      '      return',
      '    }',
      "    res.writeHead(200, { 'content-type': 'application/json' })",
      '    res.end(JSON.stringify({ plugin: "dsh-restart" }))',
      '    return',
      '  }',
    )
  }
  lines.push(
    '  res.writeHead(404)',
    '  res.end()',
    '})',
    "server.listen(port, '127.0.0.1', () => {",
    '  const target = process.env.FAKE_WEB_PID_FILE',
    '  if (target) writeFileSync(target, String(process.pid))',
    "  console.log('fake dsh web listening on ' + port)",
    '})',
  )
  return lines.join('\n')
}

describe('helper 真进程', () => {
  it(
    '假 daemon 失败 -> 自拉起假 dsh web -> /health 探到 200 -> 返回 0',
    async () => {
      const port = await freePort()
      const daemonBin = await writeScript(
        'fake-daemon.mjs',
        "console.log('fake daemon: refusing to restart')\nprocess.exit(1)",
      )
      const dshBin = await writeScript('fake-dsh.mjs', fakeDshSource(true))
      // m7 安全锚点：两个假 bin 必须都在临时目录里，确保这个测试碰不到真 dsh。
      expect(daemonBin.startsWith(dir)).toBe(true)
      expect(dshBin.startsWith(dir)).toBe(true)

      const saved = {
        DSH_RESTART_DAEMON_BIN: process.env.DSH_RESTART_DAEMON_BIN,
        DSH_RESTART_DSH_BIN: process.env.DSH_RESTART_DSH_BIN,
        FAKE_WEB_PID_FILE: process.env.FAKE_WEB_PID_FILE,
      }
      process.env.DSH_RESTART_DAEMON_BIN = daemonBin
      process.env.DSH_RESTART_DSH_BIN = dshBin
      process.env.FAKE_WEB_PID_FILE = pidFile

      const logDir = join(dir, 'logs')
      try {
        const code = await helperMain({
          env: {
            DSH_RESTART_PORT: String(port),
            DSH_RESTART_PROFILE: join(dir, 'profiles', 'web'),
            DSH_RESTART_LOG_DIR: logDir,
            DSH_RESTART_WAIT_MS: '5000',
          },
        })

        // 先读日志再断言退出码：回归时 vitest 的 diff 会直接摊出 helper 日志原文，
        // 而不是只给一句冷冰冰的 expected 1 to be 0。
        const names = await readdir(logDir).catch(() => [] as string[])
        const logName = names.find((name) => name.startsWith('helper-') && name.endsWith('.log'))
        const log = logName === undefined ? '' : await readFile(join(logDir, logName), 'utf8')
        expect(log).toContain('dsh-daemon restart 退出 code=1')
        expect(log).toContain('自拉起：dsh --profile web --port')
        expect(log).toContain('web healthy on port')
        expect(log).toContain('fake dsh web listening on')
        expect(names.includes(RESTART_LOCK_NAME)).toBe(false)
        expect(code).toBe(0)

        const pid = Number((await readFile(pidFile, 'utf8')).trim())
        expect(pid).toBeGreaterThan(0)

        const response = await fetch(`http://127.0.0.1:${port}/health`)
        expect(response.status).toBe(200)
        await response.body?.cancel()
      } finally {
        if (saved.DSH_RESTART_DAEMON_BIN === undefined) delete process.env.DSH_RESTART_DAEMON_BIN
        else process.env.DSH_RESTART_DAEMON_BIN = saved.DSH_RESTART_DAEMON_BIN
        if (saved.DSH_RESTART_DSH_BIN === undefined) delete process.env.DSH_RESTART_DSH_BIN
        else process.env.DSH_RESTART_DSH_BIN = saved.DSH_RESTART_DSH_BIN
        if (saved.FAKE_WEB_PID_FILE === undefined) delete process.env.FAKE_WEB_PID_FILE
        else process.env.FAKE_WEB_PID_FILE = saved.FAKE_WEB_PID_FILE
      }
    },
    20_000,
  )

  it(
    '假 web 不提供插件状态路由：返回 1 并报「插件未加载」',
    async () => {
      const port = await freePort()
      const daemonBin = await writeScript('fake-daemon.mjs', 'process.exit(1)')
      const dshBin = await writeScript('fake-dsh.mjs', fakeDshSource(false))

      const saved = {
        DSH_RESTART_DAEMON_BIN: process.env.DSH_RESTART_DAEMON_BIN,
        DSH_RESTART_DSH_BIN: process.env.DSH_RESTART_DSH_BIN,
        FAKE_WEB_PID_FILE: process.env.FAKE_WEB_PID_FILE,
      }
      process.env.DSH_RESTART_DAEMON_BIN = daemonBin
      process.env.DSH_RESTART_DSH_BIN = dshBin
      process.env.FAKE_WEB_PID_FILE = pidFile

      const logDir = join(dir, 'logs')
      try {
        const code = await helperMain({
          env: {
            DSH_RESTART_PORT: String(port),
            DSH_RESTART_PROFILE: join(dir, 'profiles', 'web'),
            DSH_RESTART_LOG_DIR: logDir,
            DSH_RESTART_WAIT_MS: '5000',
            DSH_RESTART_PLUGIN_GRACE_MS: '300',
          },
        })

        const names = await readdir(logDir).catch(() => [] as string[])
        const logName = names.find((name) => name.startsWith('helper-') && name.endsWith('.log'))
        const log = logName === undefined ? '' : await readFile(join(logDir, logName), 'utf8')
        expect(log).toContain('自拉起：dsh --profile web --port')
        expect(log).toContain('插件未加载')
        expect(names.includes(RESTART_LOCK_NAME)).toBe(false)
        expect(code).toBe(1)
      } finally {
        if (saved.DSH_RESTART_DAEMON_BIN === undefined) delete process.env.DSH_RESTART_DAEMON_BIN
        else process.env.DSH_RESTART_DAEMON_BIN = saved.DSH_RESTART_DAEMON_BIN
        if (saved.DSH_RESTART_DSH_BIN === undefined) delete process.env.DSH_RESTART_DSH_BIN
        else process.env.DSH_RESTART_DSH_BIN = saved.DSH_RESTART_DSH_BIN
        if (saved.FAKE_WEB_PID_FILE === undefined) delete process.env.FAKE_WEB_PID_FILE
        else process.env.FAKE_WEB_PID_FILE = saved.FAKE_WEB_PID_FILE
      }
    },
    20_000,
  )
})
