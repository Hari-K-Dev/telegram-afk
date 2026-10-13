#!/usr/bin/env bun
// Control the Telegram daemon from the Mac.
//   bun ctl.ts token          save the bot token (prompted, never echoed)
//   bun ctl.ts token --clipboard   same, read from the clipboard (then cleared)
//   bun ctl.ts pair <CODE>    approve your Telegram account (code from DMing the bot)
//   bun ctl.ts status         show pairing, AFK mode and live sessions
//   bun ctl.ts afk on|off     toggle automatic end-of-turn updates
import { createConnection } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { CONFIG_DIR, ENV_PATH, SOCKET_PATH, START_HINT } from './shared.ts'

const [cmd, arg] = process.argv.slice(2)

function call(msg: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = createConnection(SOCKET_PATH)
    let buf = ''
    s.on('connect', () => s.write(JSON.stringify(msg) + '\n'))
    s.on('data', d => { buf += d })
    s.on('close', () => { try { resolve(JSON.parse(buf)) } catch { reject(new Error('No reply from daemon')) } })
    s.on('error', () => reject(new Error(`Daemon is not running. ${START_HINT}`)))
  })
}

async function main() {
  switch (cmd) {
    case 'token': {
      let token = ''
      if (arg === '--clipboard') {
        // For non-interactive shells: read the copied token, then clear the clipboard.
        token = Bun.spawnSync(['pbpaste']).stdout.toString().trim()
        Bun.spawnSync(['pbcopy'], { stdin: new TextEncoder().encode('') })
      } else {
        process.stdout.write('Paste the bot token from BotFather (input hidden): ')
        Bun.spawnSync(['stty', '-echo'], { stdin: 'inherit' })
        for await (const line of console) { token = line.trim(); break }
        Bun.spawnSync(['stty', 'echo'], { stdin: 'inherit' })
        process.stdout.write('\n')
      }
      if (!/^\d+:[\w-]{30,}$/.test(token)) throw new Error("That doesn't look like a bot token (expected 123456:ABC...).")
      mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
      writeFileSync(ENV_PATH, `TELEGRAM_BOT_TOKEN=${token}\n`, { mode: 0o600 })
      console.log(`Saved to ${ENV_PATH} (owner-only). Restart the daemon to use it.`)
      return
    }
    case 'pair': {
      if (!arg) throw new Error('Usage: bun ctl.ts pair <CODE>')
      const r = await call({ type: 'pair', code: arg })
      console.log(r.ok ? `Paired with ${r.owner}.` : r.error)
      return
    }
    case 'status':
      console.log(JSON.stringify(await call({ type: 'status' }), null, 2))
      return
    case 'afk': {
      if (arg !== 'on' && arg !== 'off') throw new Error('Usage: bun ctl.ts afk on|off')
      const r = await call({ type: 'afk', on: arg === 'on' })
      console.log(`AFK mode ${r.afk ? 'on' : 'off'}.`)
      return
    }
    default:
      console.log('Usage: bun ctl.ts token | pair <CODE> | status | afk on|off')
  }
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
