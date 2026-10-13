// End-to-end: real daemon + two real channel servers against a fake Telegram Bot API.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = '123456:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN'
const OWNER = 42
const dir = mkdtempSync(join(tmpdir(), 'claude-tg-test-'))
const sock = join(dir, 'tgd.sock')

// ---------- fake Telegram ----------
type Call = { method: string; body: any }
const calls: Call[] = []
const updates: any[] = []
let updateId = 1
let nextThread = 100

async function parseBody(req: Request): Promise<any> {
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('json')) return req.json()
  if (ct.includes('multipart')) {
    const fd = await req.formData()
    const o: any = {}
    for (const [k, v] of fd.entries()) o[k] = typeof v === 'string' ? v : `<file:${(v as File).name}>`
    return o
  }
  return {}
}

const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/file/')) return new Response('PHOTO-BYTES')
    const method = url.pathname.split('/').pop()!
    const body = await parseBody(req)
    if (method !== 'getUpdates') calls.push({ method, body })
    const ok = (result: unknown) => Response.json({ ok: true, result })
    switch (method) {
      case 'getMe': return ok({ id: 1, is_bot: true, first_name: 'T', username: 'test_bot' })
      case 'getUpdates': {
        for (let i = 0; i < 20 && !updates.length; i++) await Bun.sleep(50)
        return ok(updates.splice(0))
      }
      case 'createForumTopic': return ok({ message_thread_id: nextThread++, name: body.name, icon_color: 0 })
      case 'getFile': return ok({ file_id: body.file_id, file_unique_id: 'u', file_path: 'photos/p.jpg' })
      case 'sendMessage': case 'sendPhoto': case 'sendDocument': case 'sendVoice':
        return ok({ message_id: calls.length, date: 0, chat: { id: OWNER, type: 'private' }, text: body.text })
      default: return ok(true)
    }
  },
})
const API = `http://localhost:${server.port}`

function push(message: any) {
  updates.push({ update_id: updateId++, message: { message_id: updateId, date: 0, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, is_bot: false, first_name: 'Owner' }, ...message } })
}

async function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(50)
  }
}

const sent = (pred: (c: Call) => boolean) => calls.find(c => ['sendMessage', 'sendPhoto', 'sendDocument'].includes(c.method) && pred(c))

function ctl(msg: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = createConnection(sock)
    let buf = ''
    s.on('connect', () => s.write(JSON.stringify(msg) + '\n'))
    s.on('data', d => { buf += d })
    s.on('close', () => resolve(buf ? JSON.parse(buf) : null))
    s.on('error', reject)
  })
}

const env = { ...process.env, CLAUDE_TG_DIR: dir, TELEGRAM_BOT_TOKEN: TOKEN, CLAUDE_TG_API_ROOT: API } as Record<string, string>
let daemon: ReturnType<typeof Bun.spawn>
type Sess = { client: Client; events: any[] }
const sessions: Record<string, Sess> = {}

async function startSession(name: string, pid: number): Promise<Sess> {
  const client = new Client({ name: 'test', version: '0' })
  const events: any[] = []
  client.fallbackNotificationHandler = async n => { events.push(n) }
  await client.connect(new StdioClientTransport({
    command: 'bun', args: [join(import.meta.dir, 'channel.ts')],
    env: { ...env, CLAUDE_TG_NAME: name, CLAUDE_TG_PID: String(pid) }, stderr: 'ignore',
  }))
  return { client, events }
}

beforeAll(async () => {
  daemon = Bun.spawn(['bun', join(import.meta.dir, 'daemon.ts')], { env, stderr: 'ignore' })
  await until(() => calls.find(c => c.method === 'setMyCommands'))
})

afterAll(async () => {
  for (const s of Object.values(sessions)) await s.client.close().catch(() => {})
  daemon.kill()
  server.stop(true)
})

test('pairing requires a code confirmed on the Mac', async () => {
  push({ text: '/start' })
  const msg = await until(() => sent(c => /Pairing code: (\w+)/.test(c.body.text)))
  const code = /Pairing code: (\w+)/.exec(msg.body.text)![1]
  expect((await ctl({ type: 'pair', code: 'WRONG1' })).ok).toBe(false)
  expect((await ctl({ type: 'pair', code })).ok).toBe(true)
})

test('each session gets its own topic', async () => {
  sessions.A = await startSession('projA', 1111)
  sessions.B = await startSession('projB', 2222)
  await until(() => calls.filter(c => c.method === 'createForumTopic').length === 2 || undefined)
  const topics = calls.filter(c => c.method === 'createForumTopic').map(c => c.body.name).sort()
  expect(topics).toEqual(['projA', 'projB'])
  await until(() => sent(c => c.body.message_thread_id === 100 && c.body.text.includes('online')))
  await until(() => sent(c => c.body.message_thread_id === 101 && c.body.text.includes('online')))
})

test('a message in a topic reaches only that session', async () => {
  const st = await ctl({ type: 'status' })
  const threadB = st.sessions.find((s: any) => s.name === 'projB').thread_id
  push({ text: 'run the tests please', message_thread_id: threadB, is_topic_message: true })
  const ev = await until(() => sessions.B!.events.find(e => e.params?.content === 'run the tests please'))
  expect(ev.method).toBe('notifications/claude/channel')
  expect(ev.params.meta.from).toBe('Owner')
  await Bun.sleep(300)
  expect(sessions.A!.events.find(e => e.params?.content === 'run the tests please')).toBeUndefined()
})

test('photos are downloaded and passed as file paths', async () => {
  const st = await ctl({ type: 'status' })
  const threadA = st.sessions.find((s: any) => s.name === 'projA').thread_id
  push({ caption: 'fix this', photo: [{ file_id: 'small', file_unique_id: 's', width: 1, height: 1 }, { file_id: 'big', file_unique_id: 'b', width: 9, height: 9 }], message_thread_id: threadA })
  const ev = await until(() => sessions.A!.events.find(e => e.params?.content === 'fix this'))
  expect(ev.params.meta.files).toContain(join(dir, 'inbox'))
  expect(await Bun.file(ev.params.meta.files).text()).toBe('PHOTO-BYTES')
})

test('strangers are ignored', async () => {
  updates.push({ update_id: updateId++, message: { message_id: 999, date: 0, chat: { id: 99, type: 'private' }, from: { id: 99, is_bot: false, first_name: 'Eve' }, text: 'rm -rf everything' } })
  await Bun.sleep(1500)
  for (const s of Object.values(sessions)) expect(s.events.find(e => e.params?.content?.includes('rm -rf'))).toBeUndefined()
})

test('reply tool posts text and files into the session topic', async () => {
  const f = join(dir, 'report.pdf')
  writeFileSync(f, 'pdf')
  const r: any = await sessions.B!.client.callTool({ name: 'reply', arguments: { text: 'All green', files: [f] } })
  expect(r.isError).toBeFalsy()
  await until(() => sent(c => c.body.text === 'All green' && c.body.message_thread_id === 101))
  await until(() => calls.find(c => c.method === 'sendDocument' && String(c.body.message_thread_id) === '101'))
  const bad: any = await sessions.B!.client.callTool({ name: 'reply', arguments: { text: 'x', files: ['relative.txt'] } })
  expect(bad.isError).toBe(true)
})

test('permission prompts relay with buttons and route the verdict back', async () => {
  await sessions.A!.client.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: 'abcde', tool_name: 'Bash', description: 'Run tests', input_preview: '{"command":"npm test"}' },
  } as any)
  const prompt = await until(() => sent(c => c.body.text?.includes('Permission needed') && c.body.message_thread_id === 100))
  expect(JSON.stringify(prompt.body.reply_markup)).toContain('p:allow:abcde')
  updates.push({ update_id: updateId++, callback_query: { id: 'cb1', chat_instance: 'x', data: 'p:allow:abcde', from: { id: OWNER, is_bot: false, first_name: 'Owner' }, message: { message_id: 5, date: 0, chat: { id: OWNER, type: 'private' }, message_thread_id: 100 } } })
  const v = await until(() => sessions.A!.events.find(e => e.method === 'notifications/claude/channel/permission'))
  expect(v.params).toEqual({ request_id: 'abcde', behavior: 'allow' })
  // typed fallback
  push({ text: 'no fghij', message_thread_id: 100 })
  await until(() => sessions.A!.events.find(e => e.params?.request_id === 'fghij' && e.params.behavior === 'deny'))
})

test('Stop hook posts only in AFK mode and not after an explicit reply', async () => {
  const hook = (message: string) => ctl({ type: 'hook', event: 'Stop', pids: [1111], message })
  await hook('quiet turn')
  await Bun.sleep(300)
  expect(sent(c => c.body.text?.includes('quiet turn'))).toBeUndefined()

  await ctl({ type: 'afk', on: true })
  await hook('finished the refactor')
  await until(() => sent(c => c.body.text?.includes('finished the refactor') && c.body.message_thread_id === 100))

  await sessions.A!.client.callTool({ name: 'reply', arguments: { text: 'explicit update' } })
  await hook('duplicate summary')
  await Bun.sleep(1500)
  expect(sent(c => c.body.text?.includes('duplicate summary'))).toBeUndefined()
}, 20000)

test('a restarted session reuses its topic', async () => {
  await sessions.A!.client.close()
  await until(() => sent(c => c.body.text?.includes('Session ended') && c.body.message_thread_id === 100))
  sessions.A = await startSession('projA', 3333)
  await until(() => calls.filter(c => c.body?.text?.includes('online') && c.body.message_thread_id === 100).length === 2 || undefined)
  expect(calls.filter(c => c.method === 'createForumTopic').length).toBe(2)
}, 20000)
