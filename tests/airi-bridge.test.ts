import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { DEMO_ORIGIN, pageOriginAllowed, startBridge } from '../bridge/airi-mcp.mjs'

type Bridge = Awaited<ReturnType<typeof startBridge>>
const open: { bridge?: Bridge; page?: WebSocket; client?: Client } = {}

afterEach(async () => {
  await open.client?.close().catch(() => {})
  open.page?.terminate()
  await open.bridge?.close()
  open.client = open.page = open.bridge = undefined
})

/** a stand-in for the game page: answers requests, remembers what it was sent */
async function fakePage(port: number, origin = 'http://localhost:5173') {
  const page = new WebSocket(`ws://127.0.0.1:${port}`, { origin })
  const got: { control: boolean[]; acts: unknown[] } = { control: [], acts: [] }
  page.on('message', raw => {
    const msg = JSON.parse(String(raw))
    if (msg.type === 'control') { got.control.push(msg.on); return }
    if (msg.method === 'status') page.send(JSON.stringify({ id: msg.id, result: { time: 'Day 1 08:00', you: { name: 'Airi' } } }))
    else if (msg.method === 'act') { got.acts.push(msg.params); page.send(JSON.stringify({ id: msg.id, result: { accepted: 'doing it now' } })) }
    else page.send(JSON.stringify({ id: msg.id, error: 'nope' }))
  })
  await new Promise<void>((resolve, reject) => { page.once('open', () => resolve()); page.once('error', reject) })
  return { page, got }
}

const until = async (ok: () => boolean, ms = 2000) => { for (let i = 0; i < ms / 20 && !ok(); i++) await new Promise(r => setTimeout(r, 20)) }
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0].text)

describe('AIRI bridge', () => {
  it('accepts game pages only from this computer, the live demo, or named origins', () => {
    expect(pageOriginAllowed('http://localhost:5173')).toBe(true)
    expect(pageOriginAllowed('http://127.0.0.1:4173')).toBe(true)
    expect(pageOriginAllowed(DEMO_ORIGIN)).toBe(true)
    expect(pageOriginAllowed('https://example.com')).toBe(false)
    expect(pageOriginAllowed('https://example.com', ['https://example.com'])).toBe(true)
    expect(pageOriginAllowed(undefined)).toBe(false)
    expect(pageOriginAllowed('file://')).toBe(false)
  })

  it('refuses a WebSocket from another web page', async () => {
    open.bridge = await startBridge({ wsPort: 0 })
    await expect(fakePage(open.bridge.wsPort, 'https://example.com')).rejects.toThrow()
  })

  it('serves the tools over HTTP, passes calls to the game page, and gives control while a client is connected', { timeout: 20000 }, async () => {
    open.bridge = await startBridge({ wsPort: 0, httpPort: 0 })
    const { page, got } = await fakePage(open.bridge.wsPort)
    open.page = page
    await until(() => got.control.length > 0)
    expect(got.control.at(-1)).toBe(false) // no AIRI yet

    const client = new Client({ name: 'test', version: '1.0.0' })
    open.client = client
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${open.bridge.httpPort}/mcp`)))
    await until(() => got.control.at(-1) === true)
    expect(got.control.at(-1)).toBe(true)

    const tools = (await client.listTools()).tools.map(t => t.name).sort()
    expect(tools).toEqual(['act', 'look', 'wait_for_event', 'world_status'])

    expect(text(await client.callTool({ name: 'world_status', arguments: {} }))).toContain('Day 1 08:00')
    const act = await client.callTool({ name: 'act', arguments: { type: 'interact', object: 'bookshelf', verb: 'read', interrupt: true } })
    expect(text(act)).toContain('doing it now')
    expect(got.acts).toEqual([{ type: 'interact', object: 'bookshelf', verb: 'read', interrupt: true }])
    // the page's own errors come back as tool errors
    const look = await client.callTool({ name: 'look', arguments: {} })
    expect(look.isError).toBe(true)

    // events: what the page reports is handed out once, and a wait ends as soon as one arrives
    page.send(JSON.stringify({ type: 'event', event: { time: 'Day 1 08:01', kind: 'memory', text: 'heard Luna say "hi"' } }))
    const first = await client.callTool({ name: 'wait_for_event', arguments: { timeout_seconds: 5 } })
    expect(text(first)).toContain('heard Luna say')
    const waiting = client.callTool({ name: 'wait_for_event', arguments: { timeout_seconds: 5 } })
    setTimeout(() => page.send(JSON.stringify({ type: 'event', event: { time: 'Day 1 08:02', kind: 'turn', text: 'your turn' } })), 100)
    expect(text(await waiting)).toContain('your turn')
    const none = await client.callTool({ name: 'wait_for_event', arguments: { timeout_seconds: 1 } })
    expect(text(none)).toContain('nothing happened yet')

    // AIRI closes the connection without ending the session: the bridge notices its event stream is gone
    await client.close()
    open.client = undefined
    await until(() => got.control.at(-1) === false, 8000)
    expect(got.control.at(-1)).toBe(false)
  })

  it('runs over stdio, the way AIRI starts it', { timeout: 20000 }, async () => {
    const client = new Client({ name: 'test', version: '1.0.0' })
    open.client = client
    const script = fileURLToPath(new URL('../bridge/airi-mcp.mjs', import.meta.url))
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, '--ws', '0'], stderr: 'pipe' }))
    expect((await client.listTools()).tools.map(t => t.name)).toContain('act')
    const r = await client.callTool({ name: 'look', arguments: {} })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('?airi')
  })

  it('says how to open the game when no page is connected', async () => {
    open.bridge = await startBridge({ wsPort: 0, httpPort: 0 })
    const client = new Client({ name: 'test', version: '1.0.0' })
    open.client = client
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${open.bridge.httpPort}/mcp`)))
    const r = await client.callTool({ name: 'world_status', arguments: {} })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('?airi')
  })
})
