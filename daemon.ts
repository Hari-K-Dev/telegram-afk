#!/usr/bin/env bun
// tgd: the single process that owns the Telegram bot. Telegram allows one
// poller per bot token, so every Claude Code session talks to this daemon over
// a Unix socket instead of polling Telegram itself. Each session gets its own
// forum topic; messages typed in a topic are routed to that session only.
import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy'
import { createConnection, createServer, type Socket } from 'node:net'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  CONFIG_DIR, ENV_PATH, INBOX_DIR, SOCKET_PATH, STATE_PATH,
  encode, lineReader, type FromDaemon, type ToDaemon,
} from './shared.ts'

type CtlMessage = { type: 'pair'; code: string } | { type: 'status' } | { type: 'afk'; on: boolean }

type State = {
  owner_id?: number
  owner_name?: string
  group_id?: number // optional: use a topics-enabled supergroup instead of the private chat
  afk: boolean
  topics: Record<string, number> // session name -> message_thread_id, reused across restarts
}

type Session = {
  sock: Socket
  name: string
  cwd: string
  pid: number
  thread_id: number // 0 means no topic (fallback: prefixed messages in the main chat)
  repliedSinceStop: boolean
}

const log = (...a: unknown[]) => console.error(new Date().toISOString(), ...a)

// ---------- config and state ----------

mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })

function readToken(): string {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN
  try {
    chmodSync(ENV_PATH, 0o600)
    const m = readFileSync(ENV_PATH, 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)
    if (m) return m[1]!.trim()
  } catch {}
  log(`No bot token. Save it with: bun ctl.ts token`)
  process.exit(1)
}

function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    return { afk: false, topics: {}, ...s }
  } catch {
    return { afk: false, topics: {} }
  }
}

let state = loadState()
function saveState() {
  const tmp = STATE_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(tmp, STATE_PATH)
}

const token = readToken()
const bot = new Bot(token, process.env.CLAUDE_TG_API_ROOT ? { client: { apiRoot: process.env.CLAUDE_TG_API_ROOT } } : undefined)
const fileRoot = process.env.CLAUDE_TG_API_ROOT ?? 'https://api.telegram.org'
const sessions = new Set<Session>()
const pendingPairs = new Map<string, { id: number; name: string }>()

const targetChat = () => state.group_id ?? state.owner_id

// ---------- outbound queue (Telegram allows about 1 message per second per chat) ----------

type Job = () => Promise<unknown>
const queue: Job[] = []
let draining = false

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    queue.push(() => job().then(resolve, reject))
    void drain()
  })
}

async function drain() {
  if (draining) return
  draining = true
  while (queue.length) {
    const job = queue.shift()!
    for (let attempt = 0; ; attempt++) {
      try {
        await job()
        break
      } catch (err) {
        const retry = err instanceof GrammyError && err.error_code === 429
          ? (err.parameters.retry_after ?? 3) : 0
        if (!retry || attempt >= 3) {
          log('send failed:', err instanceof Error ? err.message : err)
          break
        }
        await Bun.sleep(retry * 1000)
      }
    }
    await Bun.sleep(1100)
  }
  draining = false
}

const LIMIT = 4000
function chunks(text: string): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > LIMIT) {
    let cut = rest.lastIndexOf('\n', LIMIT)
    if (cut < LIMIT / 2) cut = LIMIT
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) out.push(rest)
  return out
}

function threadOpts(thread_id: number) {
  return thread_id ? { message_thread_id: thread_id } : {}
}

async function sendText(thread_id: number, text: string, extra: object = {}) {
  const chat = targetChat()
  if (!chat) throw new Error('Bot is not paired with your Telegram account yet')
  let last: unknown
  for (const part of chunks(text)) {
    last = await enqueue(() => bot.api.sendMessage(chat, part, { ...threadOpts(thread_id), ...extra }))
  }
  return last
}

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
async function sendFile(thread_id: number, path: string) {
  const chat = targetChat()
  if (!chat) throw new Error('Bot is not paired with your Telegram account yet')
  if (!existsSync(path)) throw new Error(`File not found: ${path}`)
  const file = new InputFile(path, basename(path))
  return PHOTO_EXT.has(extname(path).toLowerCase())
    ? enqueue(() => bot.api.sendPhoto(chat, file, threadOpts(thread_id)))
    : enqueue(() => bot.api.sendDocument(chat, file, threadOpts(thread_id)))
}

// ---------- AFK mode ----------

function setAfk(on: boolean) {
  state.afk = on
  saveState()
}

// ---------- topics ----------

async function topicFor(name: string): Promise<number> {
  const known = state.topics[name]
  if (known) return known
  const chat = targetChat()
  if (!chat) return 0
  try {
    const t = await enqueue(() => bot.api.createForumTopic(chat, name))
    state.topics[name] = t.message_thread_id
    saveState()
    return t.message_thread_id
  } catch (err) {
    log(`createForumTopic failed (is Threaded Mode on in BotFather?):`, err instanceof Error ? err.message : err)
    return 0
  }
}

function uniqueName(base: string): string {
  const live = new Set([...sessions].map(s => s.name))
  if (!live.has(base)) return base
  for (let i = 2; ; i++) if (!live.has(`${base}-${i}`)) return `${base}-${i}`
}

function label(s: Session) {
  return s.thread_id ? '' : `[${s.name}] `
}

function send(s: Session, msg: FromDaemon) {
  if (!s.sock.destroyed) s.sock.write(encode(msg))
}

function sessionList(): string {
  if (!sessions.size) return 'No Claude sessions are connected.'
  return 'Live sessions:\n' + [...sessions].map(s => `- ${s.name}  (${s.cwd})`).join('\n')
}

// ---------- socket server ----------

async function handle(sock: Socket, msg: ToDaemon | CtlMessage, self: { session?: Session }) {
  switch (msg.type) {
    case 'register': {
      const name = uniqueName(msg.name)
      const thread_id = await topicFor(name)
      const s: Session = { sock, name, cwd: msg.cwd, pid: msg.pid, thread_id, repliedSinceStop: false }
      sessions.add(s)
      self.session = s
      send(s, { type: 'registered', name, thread_id })
      log(`session online: ${name} pid=${msg.pid} thread=${thread_id}`)
      if (targetChat()) {
        await sendText(thread_id, `${label(s)}🟢 Session online\n${msg.cwd}${state.afk ? '\nAFK mode is on.' : ''}`).catch(() => {})
      }
      return
    }
    case 'send': {
      const s = self.session
      if (!s) return
      try {
        if (msg.text?.trim()) await sendText(s.thread_id, label(s) + msg.text)
        for (const f of msg.files ?? []) await sendFile(s.thread_id, f)
        s.repliedSinceStop = true
        send(s, { type: 'ack', id: msg.id, ok: true })
      } catch (err) {
        send(s, { type: 'ack', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }
    case 'permission_request': {
      const s = self.session
      if (!s) return
      const kb = new InlineKeyboard()
        .text('✅ Allow', `p:allow:${msg.request_id}`)
        .text('❌ Deny', `p:deny:${msg.request_id}`)
      const preview = msg.input_preview.length > 1500 ? msg.input_preview.slice(0, 1500) + ' …' : msg.input_preview
      await sendText(
        s.thread_id,
        `${label(s)}🔐 Permission needed: ${msg.tool_name}\n${msg.description}\n\n${preview}\n\nTap a button, or reply "yes ${msg.request_id}" / "no ${msg.request_id}".`,
        { reply_markup: kb },
      ).catch(err => log('permission relay failed:', err))
      return
    }
    case 'hook': {
      const s = [...sessions].find(x => msg.pids.includes(x.pid))
      sock.end()
      if (!s || !state.afk || !targetChat()) {
        if (s && msg.event === 'Stop') s.repliedSinceStop = false
        return
      }
      if (msg.event === 'Stop') {
        // Skip the summary if Claude already replied on Telegram this turn.
        const replied = s.repliedSinceStop
        s.repliedSinceStop = false
        if (!replied && msg.message?.trim()) {
          const body = msg.message.length > 3000 ? msg.message.slice(0, 3000) + '\n…' : msg.message
          await sendText(s.thread_id, `${label(s)}✅ Turn finished\n\n${body}`).catch(() => {})
        }
      } else if (msg.event === 'Notification' && msg.notification_type === 'idle_prompt') {
        await sendText(s.thread_id, `${label(s)}⏳ Waiting for you. Reply here to continue.`).catch(() => {})
      }
      return
    }
    // ----- control messages from ctl.ts -----
    case 'pair': {
      const p = pendingPairs.get(msg.code.trim().toUpperCase())
      if (!p) {
        sock.end(JSON.stringify({ ok: false, error: 'Unknown or expired code. DM the bot again for a new one.' }) + '\n')
        return
      }
      state.owner_id = p.id
      state.owner_name = p.name
      saveState()
      pendingPairs.clear()
      await sendText(0, 'Paired. Claude sessions will each get their own topic here.\nCommands: /sessions /afk /back').catch(() => {})
      sock.end(JSON.stringify({ ok: true, owner: p.name }) + '\n')
      return
    }
    case 'status': {
      sock.end(JSON.stringify({ ok: true, owner: state.owner_name ?? null, afk: state.afk, sessions: [...sessions].map(s => ({ name: s.name, cwd: s.cwd, thread_id: s.thread_id })) }) + '\n')
      return
    }
    case 'afk': {
      setAfk(msg.on)
      sock.end(JSON.stringify({ ok: true, afk: state.afk }) + '\n')
      return
    }
  }
}

async function startSocket() {
  // Refuse to start twice: if something answers on the socket, another daemon is live.
  if (existsSync(SOCKET_PATH)) {
    const alive = await new Promise<boolean>(res => {
      const c = createConnection(SOCKET_PATH)
      c.once('connect', () => { c.destroy(); res(true) })
      c.once('error', () => res(false))
    })
    if (alive) {
      log('Another tgd is already running. Exiting.')
      process.exit(0)
    }
    unlinkSync(SOCKET_PATH)
  }
  const server = createServer(sock => {
    const self: { session?: Session } = {}
    sock.on('data', lineReader<ToDaemon | CtlMessage>(m => {
      handle(sock, m, self).catch(err => log('handler error:', err))
    }))
    sock.on('error', () => {})
    sock.on('close', () => {
      const s = self.session
      if (!s) return
      sessions.delete(s)
      log(`session offline: ${s.name}`)
      if (targetChat()) void sendText(s.thread_id, `${label(s)}⚪ Session ended`).catch(() => {})
    })
  })
  await new Promise<void>(res => server.listen(SOCKET_PATH, res))
  chmodSync(SOCKET_PATH, 0o600)
  log(`listening on ${SOCKET_PATH}`)
}

// ---------- Telegram inbound ----------

const VERDICT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

function sessionForThread(thread_id: number | undefined): Session | undefined {
  if (thread_id) return [...sessions].find(s => s.thread_id === thread_id)
  // No topics in use: route to the only session, if there is exactly one.
  const untopiced = [...sessions].filter(s => s.thread_id === 0)
  return untopiced.length === 1 ? untopiced[0] : undefined
}

async function download(fileId: string, name: string): Promise<string> {
  const f = await bot.api.getFile(fileId)
  if (!f.file_path) throw new Error('Telegram returned no file path')
  const res = await fetch(`${fileRoot}/file/bot${token}/${f.file_path}`)
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
  const safe = name.replace(/[^\w.\-]+/g, '_').slice(-80) || 'file'
  const path = join(INBOX_DIR, `${Date.now()}_${safe}`)
  await Bun.write(path, await res.arrayBuffer())
  return path
}

bot.on('message', async ctx => {
  const from = ctx.from
  if (!from) return

  // Pairing: until an owner is set, any DM gets a code that must be confirmed on the Mac.
  if (!state.owner_id) {
    if (ctx.chat.type !== 'private') return
    const code = randomBytes(3).toString('hex').toUpperCase()
    pendingPairs.set(code, { id: from.id, name: [from.first_name, from.last_name].filter(Boolean).join(' ') })
    log(`pairing request from ${from.id}`)
    await ctx.reply(`Pairing code: ${code}\nIn the telegram-afk folder on your Mac, run:\n  bun ctl.ts pair ${code}`)
    return
  }
  // Gate on the sender, not the chat, so group members can't inject.
  if (from.id !== state.owner_id) return
  if (state.group_id ? ctx.chat.id !== state.group_id : ctx.chat.id !== state.owner_id) return

  const thread_id = ctx.message.message_thread_id
  const text = ctx.message.text ?? ctx.message.caption ?? ''
  const reply = (t: string) => ctx.reply(t, threadOpts(thread_id ?? 0)).catch(() => {})

  const cmd = text.trim().split(/\s+/)[0]?.toLowerCase().replace(/@\w+$/, '')
  if (cmd === '/sessions' || cmd === '/start' || cmd === '/help') {
    await reply(`${sessionList()}\n\nAFK mode: ${state.afk ? 'on' : 'off'}\n/afk  post an update here when a session finishes a turn\n/back  stop automatic updates`)
    return
  }
  if (cmd === '/afk' || cmd === '/back') {
    setAfk(cmd === '/afk')
    await reply(state.afk
      ? 'AFK mode on. Each session will post an update here when it finishes a turn.'
      : 'AFK mode off.')
    return
  }
  const s = sessionForThread(thread_id)
  if (!s) {
    await reply(thread_id
      ? 'No live session in this topic. It may have ended.\n\n' + sessionList()
      : 'Write inside a session topic so I know which session it is for.\n\n' + sessionList())
    return
  }

  const v = VERDICT_RE.exec(text)
  if (v) {
    send(s, { type: 'verdict', request_id: v[2]!.toLowerCase(), behavior: v[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny' })
    await ctx.react('👍').catch(() => {})
    return
  }

  const files: string[] = []
  try {
    const m = ctx.message
    if (m.photo?.length) files.push(await download(m.photo.at(-1)!.file_id, 'photo.jpg'))
    if (m.document) files.push(await download(m.document.file_id, m.document.file_name ?? 'document'))
    if (m.audio) files.push(await download(m.audio.file_id, m.audio.file_name ?? 'audio'))
    if (m.video) files.push(await download(m.video.file_id, m.video.file_name ?? 'video.mp4'))
  } catch (err) {
    await reply(`Couldn't fetch the attachment: ${err instanceof Error ? err.message : err}`)
  }
  if (!text && !files.length) return

  send(s, { type: 'inbound', text, message_id: ctx.message.message_id, from: from.first_name, files })
  await ctx.react('👀').catch(() => {})
})

bot.on('callback_query:data', async ctx => {
  if (ctx.from.id !== state.owner_id) return ctx.answerCallbackQuery()
  const m = /^p:(allow|deny):([a-km-z]{5})$/.exec(ctx.callbackQuery.data)
  if (!m) return ctx.answerCallbackQuery()
  const s = sessionForThread(ctx.callbackQuery.message?.message_thread_id)
  if (!s) return ctx.answerCallbackQuery({ text: 'That session has ended.' })
  send(s, { type: 'verdict', request_id: m[2]!, behavior: m[1] as 'allow' | 'deny' })
  await ctx.answerCallbackQuery({ text: m[1] === 'allow' ? 'Allowed' : 'Denied' })
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
  await ctx.reply(m[1] === 'allow' ? '✅ Allowed' : '❌ Denied', threadOpts(s.thread_id)).catch(() => {})
})

bot.catch(err => log('bot error:', err.message))

// ---------- start ----------

await startSocket()
const me = await bot.api.getMe()
log(`bot @${me.username} ready${state.owner_id ? `, paired with ${state.owner_name}` : ', waiting for pairing (DM the bot)'}`)
await bot.api.setMyCommands([
  { command: 'sessions', description: 'List live Claude sessions' },
  { command: 'afk', description: 'Send me updates when sessions finish' },
  { command: 'back', description: 'Stop automatic updates' },
]).catch(() => {})

const shutdown = () => {
  log('shutting down')
  bot.stop().finally(() => {
    try { unlinkSync(SOCKET_PATH) } catch {}
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await bot.start({ allowed_updates: ['message', 'callback_query'], drop_pending_updates: false })
