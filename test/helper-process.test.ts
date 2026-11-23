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

describe('helper 真进程', () => {
  it(
    '假 daemon 失败 -> 自拉起假 dsh web -> /health 探到 200 -> 返回 0',
    async () => {
      const port = await freePort()
      const daemonBin = await writeScript(
        'fake-daemon.mjs',
        "console.log('fake daemon: refusing to restart')\nprocess.exit(1)",
      )
      const dshBin = await writeScript(
        'fake-dsh.mjs',
        [
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
          '  res.writeHead(404)',
          '  res.end()',
          '})',
          "server.listen(port, '127.0.0.1', () => {",
          '  const target = process.env.FAKE_WEB_PID_FILE',
          '  if (target) writeFileSync(target, String(process.pid))',
          "  console.log('fake dsh web listening on ' + port)",
          '})',
        ].join('\n'),
      )

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
            DSH_RESTART_WAIT_MS: '20000',
          },
        })

        expect(code).toBe(0)
        const pid = Number((await readFile(pidFile, 'utf8')).trim())
        expect(pid).toBeGreaterThan(0)

        const response = await fetch(`http://127.0.0.1:${port}/health`)
        expect(response.status).toBe(200)
        await response.body?.cancel()

        const names = await readdir(logDir)
        const logName = names.find((name) => name.startsWith('helper-') && name.endsWith('.log'))
        expect(logName).toBeDefined()
        const log = await readFile(join(logDir, logName as string), 'utf8')
        expect(log).toContain('dsh-daemon restart 退出 code=1')
        expect(log).toContain('自拉起：dsh --profile web --port')
        expect(log).toContain('web healthy on port')
        expect(log).toContain('fake dsh web listening on')
        expect(names.includes(RESTART_LOCK_NAME)).toBe(false)
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
