#!/usr/bin/env node
// @ts-check
/**
 * The MCP bridge between AIRI (or any MCP client) and the game. AIRI lives in the world as the character Airi and
 * decides for herself through these tools; the other characters stay NPCs. See README "AIRI in the world".
 *
 *   AIRI ⇄ MCP (stdio, or Streamable HTTP) ⇄ this bridge ⇄ WebSocket on 127.0.0.1 ⇄ the game
 *
 * The game is the Unity project (Assets/Scripts/Airi/AiriLink.cs), which connects by itself while it runs.
 *
 * Usage (from the repository root, after `npm install`):
 *   node bridge/airi-mcp.mjs                  MCP over stdio: AIRI starts this command itself
 *   node bridge/airi-mcp.mjs --http 8790      MCP over Streamable HTTP at http://127.0.0.1:8790/mcp
 * Options:
 *   --ws <port>              where the game connects (default 8789)
 *   --origin <origin,...>    web page origins to accept, besides localhost and the live demo
 *
 * Logs go to stderr: in stdio mode, stdout carries the MCP messages.
 */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

export const DEFAULT_WS_PORT = 8789
/** the live demo (GitHub Pages); it reaches a bridge on this computer only when opened with ?airi */
export const DEMO_ORIGIN = 'https://0xselenicdove.github.io'
/** how long the bridge waits for the game to answer a request */
const ANSWER_MS = 5000
/** events kept for wait_for_event while nobody asks; older ones are dropped */
const MAX_EVENTS = 200
/** an HTTP client whose event stream stays closed this long has gone away */
const STREAM_GRACE_MS = Number(process.env.AIRI_MCP_STREAM_GRACE_MS ?? 3000)

const log = (/** @type {string} */ msg) => process.stderr.write(`[airi-mcp] ${msg}\n`)

/**
 * The game may connect from here. A client that is not a web page (the Unity game) sends no Origin header, and is
 * accepted: a browser always sends one, so a web page cannot leave it out. A web page is accepted only from this
 * computer, the live demo, or an origin the user named; any other is refused, so it cannot pose as the game and feed
 * AIRI made-up observations.
 * @param {string | undefined} origin
 * @param {string[]} extra
 */
export function pageOriginAllowed(origin, extra = []) {
  if (origin === undefined) return true
  if (origin === DEMO_ORIGIN || extra.includes(origin)) return true
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

/** The one game connected over the WebSocket: requests to it, and the events it reports. */
export class GameLink {
  constructor() {
    /** @type {import('ws').WebSocket | null} */
    this.page = null
    this.nextId = 1
    /** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map()
    /** @type {{ time: string, kind: string, text: string }[]} */
    this.events = []
    /** @type {(() => void)[]} */
    this.waiters = []
    /** MCP clients connected now: while there is one, AIRI plays her character */
    this.clients = 0
  }

  /** @param {import('ws').WebSocket} ws */
  attach(ws) {
    // one game at a time: a newly opened page takes over from the old one
    if (this.page) this.page.close(4000, 'another game connected')
    this.page = ws
    log('game connected')
    ws.on('message', data => this.receive(String(data)))
    ws.on('close', () => {
      if (this.page !== ws) return
      this.page = null
      log('game left')
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('the game closed')) }
      this.pending.clear()
    })
    this.sendControl()
  }

  /** @param {number} n */
  setClients(n) {
    // AIRI arriving starts with a clean slate: what happened before, under the character's own brain, is not hers
    if (n > 0 && this.clients === 0) this.events.length = 0
    this.clients = n
    this.sendControl()
  }

  sendControl() {
    this.page?.send(JSON.stringify({ type: 'control', on: this.clients > 0 }))
  }

  /** @param {string} raw */
  receive(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg?.type === 'event' && msg.event) {
      this.events.push(msg.event)
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
      for (const w of this.waiters.splice(0)) w()
      return
    }
    const p = typeof msg?.id === 'number' ? this.pending.get(msg.id) : undefined
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
  }

  /**
   * Ask the game something and wait for its answer.
   * @param {'status' | 'look' | 'act'} method
   * @param {Record<string, unknown>} [params]
   */
  request(method, params) {
    const page = this.page
    if (!page) return Promise.reject(new Error(NO_GAME))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('the game did not answer in time (is it paused?)'))
      }, ANSWER_MS)
      this.pending.set(id, { resolve, reject, timer })
      page.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * The events since the last call; if there are none, wait up to `ms` for the next one.
   * @param {number} ms
   */
  async takeEvents(ms) {
    if (!this.events.length) {
      await new Promise(resolve => {
        const timer = setTimeout(done, ms)
        function done() { clearTimeout(timer); resolve(undefined) }
        this.waiters.push(done)
      })
    }
    return this.events.splice(0)
  }
}

const NO_GAME = 'The game is not running. Start it (in the Unity editor, open Assets/Scenes/Room.unity and press Play), '
  + 'and it connects to this bridge by itself.'

/** @param {unknown} value */
const ok = value => ({ content: [{ type: /** @type {const} */ ('text'), text: JSON.stringify(value, null, 1) }] })
/** @param {unknown} err */
const fail = err => ({ content: [{ type: /** @type {const} */ ('text'), text: err instanceof Error ? err.message : String(err) }], isError: true })

/**
 * The MCP server: the tools AIRI uses to live in the game. One per MCP session.
 * @param {GameLink} link
 */
export function createMcpServer(link) {
  const server = new McpServer({ name: 'airi-v3d-game', version: '1.0.0' }, {
    instructions: 'You live in a small 3D world as the character Airi: a house with a bed, a desk with a laptop, a fridge '
      + 'and a front door to the yard. Luna lives there too. Your body has needs (energy, fun, knowledge, hunger) that change '
      + 'over time. While you are connected, you decide for yourself: use look to see your situation, act to do something, and '
      + 'wait_for_event to hear what happens next (an activity ends, someone speaks to you, or it is your turn to decide). '
      + 'If you give no action for a while (60 s by default) when it is your turn, your own habits choose that one thing for '
      + 'you, and you get an "autopilot" event; act with interrupt: true to change it.',
  })

  server.registerTool('world_status', {
    title: 'World status',
    description: 'The time in the world, what you (Airi) and the others are doing and where, and what act can do in this version.',
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return ok(await link.request('status')) } catch (e) { return fail(e) }
  })

  server.registerTool('look', {
    title: 'Look around',
    description: 'What you see right now: your needs and what you are doing, the things you can use (object ids, their '
      + 'verbs now, and who uses them), and the people nearby.',
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return ok(await link.request('look')) } catch (e) { return fail(e) }
  })

  server.registerTool('act', {
    title: 'Act',
    description: 'Do something as Airi. type "interact": use an object (object id and verb from look, for example bed + sleep). '
      + '"say": say something (the words show above your head). "wait": stay put for some game minutes. "gesture": '
      + 'move your body (a name from world_status: gestures, or a motion you describe in English when world_status says so), while standing still and when the live motion server runs. If you are busy with an activity, the action runs when it ends, unless interrupt is true, '
      + 'which ends the activity first (you get up the usual way).',
    inputSchema: {
      type: z.enum(['interact', 'say', 'gesture', 'wait']),
      object: z.string().optional().describe('interact: the object id, from look'),
      verb: z.string().optional().describe('interact: one of that object\'s verbs, from look'),
      run: z.boolean().optional().describe('interact: run there, when the way is at least 3 m and the live motion server runs'),
      text: z.string().max(400).optional().describe('say: what to say'),
      gesture: z.string().optional().describe('gesture: a gesture name from world_status'),
      motion: z.string().max(200).optional().describe('gesture: instead of a name, the motion in English, for example "a person stretches both arms over their head"'),
      minutes: z.number().min(1).max(120).optional().describe('wait: game minutes'),
      emotion: z.string().optional().describe('a facial emotion from world_status, for example happy'),
      thought: z.string().max(200).optional().describe('a short inner thought, shown above your head'),
      interrupt: z.boolean().optional().describe('end the current activity first'),
    },
  }, async args => {
    try { return ok(await link.request('act', args)) } catch (e) { return fail(e) }
  })

  server.registerTool('wait_for_event', {
    title: 'Wait for something to happen',
    description: 'What has happened to you since you last asked: what you started doing and thought, "turn" '
      + 'events when you are waiting for your next decision, and "autopilot" events when your habits decided because you '
      + 'gave no action in time. If nothing has happened yet, waits up to timeout_seconds.',
    inputSchema: { timeout_seconds: z.number().min(1).max(120).optional().describe('how long to wait, default 30') },
    annotations: { readOnlyHint: true },
  }, async ({ timeout_seconds }) => {
    if (!link.page) return fail(NO_GAME)
    const events = await link.takeEvents((timeout_seconds ?? 30) * 1000)
    return ok(events.length ? { events } : { events: [], note: 'nothing happened yet' })
  })

  return server
}

/**
 * Start the bridge: the WebSocket for the game, and MCP over stdio or HTTP.
 * @param {{ wsPort?: number, httpPort?: number, origins?: string[], stdio?: boolean }} opts
 */
export async function startBridge(opts = {}) {
  const link = new GameLink()
  const origins = opts.origins ?? []
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: opts.wsPort ?? DEFAULT_WS_PORT,
    verifyClient: ({ origin }) => {
      const okOrigin = pageOriginAllowed(origin, origins)
      if (!okOrigin) log(`refused a page from ${origin || 'an empty origin'} (add it with --origin if it is your game)`)
      return okOrigin
    },
  })
  await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject) })
  wss.on('connection', ws => link.attach(ws))
  const wsPort = /** @type {import('node:net').AddressInfo} */ (wss.address()).port
  log(`waiting for the game on ws://127.0.0.1:${wsPort} (start it, and it connects)`)

  /** @type {() => Promise<void>} */
  let closeMcp = async () => {}
  let httpPort = 0

  if (opts.httpPort !== undefined) {
    /** @type {Map<string, StreamableHTTPServerTransport>} */
    const sessions = new Map()
    /** open event streams (GET) per session */
    /** @type {Map<string, number>} */
    const streams = new Map()
    const http = createServer(async (req, res) => {
      if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end(); return }
      try {
        const sid = req.headers['mcp-session-id']
        let transport = typeof sid === 'string' ? sessions.get(sid) : undefined
        let body
        if (req.method === 'POST') {
          const chunks = []
          for await (const c of req) chunks.push(c)
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
        }
        if (!transport) {
          if (req.method !== 'POST' || !isInitializeRequest(body)) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'no valid session' }, id: null }))
            return
          }
          const t = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: true,
            allowedHosts: [`127.0.0.1:${httpPort}`, `localhost:${httpPort}`],
            onsessioninitialized: id => { sessions.set(id, t); link.setClients(sessions.size); log(`AIRI connected (session ${id.slice(0, 8)})`) },
          })
          t.onclose = () => {
            if (t.sessionId) streams.delete(t.sessionId)
            if (t.sessionId && sessions.delete(t.sessionId)) { link.setClients(sessions.size); log('AIRI disconnected') }
          }
          await createMcpServer(link).connect(t)
          transport = t
        }
        // A client that goes away without ending its session (AIRI closes the connection, it sends no DELETE) still
        // drops its event stream (the GET). If that stream does not come back soon, the client is gone: end the
        // session, so control goes back to the character's own brain.
        if (req.method === 'GET' && transport.sessionId) {
          const t = transport, id = transport.sessionId
          streams.set(id, (streams.get(id) ?? 0) + 1)
          res.on('close', () => {
            streams.set(id, (streams.get(id) ?? 1) - 1)
            setTimeout(() => { if (!streams.get(id) && sessions.has(id)) t.close() }, STREAM_GRACE_MS)
          })
        }
        await transport.handleRequest(req, res, body)
      } catch (e) {
        log(`request failed: ${e instanceof Error ? e.message : e}`)
        if (!res.headersSent) res.writeHead(500).end()
      }
    })
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(opts.httpPort, '127.0.0.1', () => resolve(undefined)) })
    httpPort = /** @type {import('node:net').AddressInfo} */ (http.address()).port
    log(`MCP over HTTP at http://127.0.0.1:${httpPort}/mcp`)
    closeMcp = async () => {
      for (const t of sessions.values()) await t.close()
      await new Promise(resolve => http.close(() => resolve(undefined)))
    }
  } else if (opts.stdio) {
    const t = new StdioServerTransport()
    await createMcpServer(link).connect(t)
    link.setClients(1)
    log('AIRI connected over stdio')
    closeMcp = async () => { await t.close() }
  }

  return {
    link,
    wsPort,
    httpPort,
    async close() {
      await closeMcp()
      for (const c of wss.clients) c.terminate()
      await new Promise(resolve => wss.close(() => resolve(undefined)))
    },
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ wsPort?: number, httpPort?: number, origins: string[] }} */
  const out = { origins: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1]
    if (a === '--ws') { out.wsPort = Number(v); i++ }
    else if (a === '--http') { out.httpPort = Number(v); i++ }
    else if (a === '--origin') { out.origins.push(...String(v).split(',').map(s => s.trim()).filter(Boolean)); i++ }
    else if (a === '--help' || a === '-h') { process.stderr.write('usage: node bridge/airi-mcp.mjs [--http <port>] [--ws <port>] [--origin <origin,...>]\n'); process.exit(0) }
    else { log(`unknown option ${a}`); process.exit(2) }
  }
  for (const [k, p] of /** @type {const} */ ([['--ws', out.wsPort], ['--http', out.httpPort]])) {
    if (p !== undefined && !(Number.isInteger(p) && p >= 0 && p < 65536)) { log(`${k} needs a port number`); process.exit(2) }
  }
  return out
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  startBridge({ ...args, stdio: args.httpPort === undefined }).then(bridge => {
    const stop = () => { bridge.close().finally(() => process.exit(0)) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    // stdio: AIRI closing the pipe ends the bridge, and frees the WebSocket port for the next start
    if (args.httpPort === undefined) process.stdin.on('close', stop)
  }, err => {
    log(err?.code === 'EADDRINUSE' ? `port in use: ${err.message} (another bridge running? pick ports with --ws / --http)` : String(err))
    process.exit(1)
  })
}
