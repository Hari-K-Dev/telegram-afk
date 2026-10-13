// Paths and wire protocol shared by the daemon, the per-session channel and the hook.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export const CONFIG_DIR = process.env.CLAUDE_TG_DIR ?? join(homedir(), '.config', 'claude-tg')
export const SOCKET_PATH = join(CONFIG_DIR, 'tgd.sock')
export const STATE_PATH = join(CONFIG_DIR, 'state.json')
export const ENV_PATH = join(CONFIG_DIR, '.env')
export const INBOX_DIR = join(CONFIG_DIR, 'inbox')
// The launchd label from the plist you installed; only used in hints.
export const LAUNCHD_LABEL = process.env.CLAUDE_TG_LABEL ?? 'io.github.hari-k-dev.telegram-afk'
export const START_HINT = `Start it with: launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`

// Messages are newline-delimited JSON over a Unix socket.
export type ToDaemon =
  | { type: 'register'; name: string; cwd: string; pid: number }
  | { type: 'send'; id: number; text: string; files?: string[] }
  | { type: 'permission_request'; request_id: string; tool_name: string; description: string; input_preview: string }
  | { type: 'hook'; event: string; pids: number[]; message?: string; notification_type?: string; session_id?: string; transcript_path?: string; cwd?: string }

export type FromDaemon =
  | { type: 'registered'; name: string; thread_id: number }
  | { type: 'ack'; id: number; ok: boolean; error?: string }
  | { type: 'inbound'; text: string; message_id: number; from: string; files: string[] }
  | { type: 'verdict'; request_id: string; behavior: 'allow' | 'deny' }

export function encode(msg: ToDaemon | FromDaemon): string {
  return JSON.stringify(msg) + '\n'
}

// Splits a byte stream into JSON messages, tolerating partial lines.
export function lineReader<T>(onMessage: (msg: T) => void) {
  let buf = ''
  return (chunk: Buffer | string) => {
    buf += chunk.toString()
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try {
        onMessage(JSON.parse(line) as T)
      } catch {
        // ignore malformed lines rather than killing the connection
      }
    }
  }
}

// Ancestor PIDs of a process, nearest first.
export function ancestorPids(pid: number = process.pid, max = 12): number[] {
  const out: number[] = []
  let cur = pid
  for (let i = 0; i < max; i++) {
    let ppid: number
    try {
      ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(cur)], { encoding: 'utf8' }).trim())
    } catch {
      break
    }
    if (!ppid || ppid <= 1) break
    out.push(ppid)
    cur = ppid
  }
  return out
}

// The nearest ancestor that is the Claude Code process. Both the channel
// server and the hook resolve this, which is how a hook finds its session.
export function claudePid(pid: number = process.pid): number | undefined {
  for (const p of ancestorPids(pid)) {
    try {
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(p)], { encoding: 'utf8' }).trim()
      const exe = (cmd.split(' ')[0] ?? '').split('/').pop()
      if (exe === 'claude') return p
    } catch {
      return undefined
    }
  }
  return undefined
}
