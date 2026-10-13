#!/usr/bin/env bun
// Stop / Notification hook. Tells the daemon a session finished a turn or is
// waiting, so it can post an update when AFK mode is on. Must never block or
// fail the session: any problem exits 0 silently.
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { SOCKET_PATH, claudePid, encode } from './shared.ts'

try {
  if (!existsSync(SOCKET_PATH)) process.exit(0)
  const input = JSON.parse(await Bun.stdin.text()) as {
    hook_event_name?: string
    last_assistant_message?: string
    notification_type?: string
    stop_hook_active?: boolean
    session_id?: string
    transcript_path?: string
    cwd?: string
  }
  if (input.stop_hook_active) process.exit(0)
  const pid = claudePid()
  if (!pid) process.exit(0)
  await new Promise<void>(resolve => {
    const s = createConnection(SOCKET_PATH)
    s.on('connect', () => {
      s.end(encode({
        type: 'hook',
        event: input.hook_event_name ?? '',
        pids: [pid],
        message: input.last_assistant_message,
        notification_type: input.notification_type,
        session_id: input.session_id,
        transcript_path: input.transcript_path,
        cwd: input.cwd,
      }))
    })
    s.on('close', () => resolve())
    s.on('error', () => resolve())
    setTimeout(resolve, 2000)
  })
} catch {}
process.exit(0)
