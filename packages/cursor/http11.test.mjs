// Cursor's HTTP Compatibility Mode (HTTP/1.1) is RunSSE plus BidiAppend,
// not the HTTP/2 stream. A fake agent API here speaks only HTTP/1.1: it
// answers nothing until the Run has been appended, then asks for a blob
// and waits for that append too, so a client that buffered the stream
// would stall. Nothing reaches Cursor.
import "./nonet.mjs" // first: no request leaves this machine
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import http from "node:http"
import http2 from "node:http2"
import { CursorAuthPlugin, _internal } from "./index.mjs"

const { fields, pb, frame } = _internal
const field = (fs, num) => fs.find((f) => f.num === num)
const pbStr = (fs, num) => field(fs, num)?.data.toString("utf8") ?? ""
const pbNum = (fs, num) => field(fs, num)?.n ?? 0

const connect = http2.connect
http2.connect = () => {
  throw new Error("a Run used HTTP/2")
}
afterAll(() => (http2.connect = connect))

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

// sub is this file's: the plugin keeps an agent URL per token, and the
// other tests' tokens are the same shape
const jwt = (exp) => ["e30", Buffer.from(JSON.stringify({ exp, sub: "http11-" + Math.random() })).toString("base64url"), "sig"].join(".")
let n = 0
const fresh = () => ({ type: "oauth", access: jwt(Math.floor(Date.now() / 1000) + 7200 + ++n), refresh: "", expires: 0, accountId: "a@b.c" })

const seen = []
const appends = []
const waiting = []
function kick() {
  for (const check of waiting.splice(0)) check()
}
function waitAppend(pred) {
  const hit = appends.find(pred)
  if (hit) return Promise.resolve(hit)
  return new Promise((resolve) => {
    const check = () => {
      const found = appends.find(pred)
      if (found) resolve(found)
      else waiting.push(check)
    }
    waiting.push(check)
  })
}

let server, base
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    seen.push({ version: req.httpVersion, path: req.url, type: req.headers["content-type"] })
    if (req.url.endsWith("/aiserver.v1.BidiService/BidiAppend")) {
      const fs = fields(body)
      const idMsg = field(fs, 2)
      appends.push({
        id: idMsg ? pbStr(fields(idMsg.data), 1) : "",
        seq: pbNum(fs, 3),
        data: field(fs, 4)?.data ?? Buffer.alloc(0),
      })
      kick()
      res.writeHead(200, { "content-type": "application/proto" })
      res.end()
      return
    }
    if (!req.url.endsWith("/agent.v1.AgentService/RunSSE")) {
      res.writeHead(404)
      res.end()
      return
    }
    const len = body.readUInt32BE(1)
    const id = pbStr(fields(body.subarray(5, 5 + len)), 1)
    const run = await waitAppend((a) => a.id === id && a.seq === 0)
    res.writeHead(200, { "content-type": "application/connect+proto" })
    // a blob the client does not have: it still has to append the miss
    // before this stream says anything of the answer
    res.write(frame(pb().bytes(4, pb().varint(1, 7).bytes(2, pb().bytes(1, Buffer.from("ab", "hex")))).done()))
    const reply = await waitAppend((a) => a.id === id && fields(a.data).some((f) => f.num === 3))
    const rr = fields(fields(run.data).find((f) => f.num === 1).data)
    seen.push({ conv: rr.find((f) => f.num === 5)?.data.toString(), blob: reply.seq })
    res.write(frame(pb().bytes(1, pb().bytes(1, pb().str(1, "hi"))).done()))
    const end = Buffer.from("{}")
    const head = Buffer.alloc(5)
    head[0] = 2
    head.writeUInt32BE(end.length, 1)
    res.end(Buffer.concat([head, end]))
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => server?.close())

function fakeAPI() {
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u === "https://api2.cursor.sh/aiserver.v1.ServerConfigService/GetServerConfig") return Response.json({ agentUrlConfig: { agentUrl: base } })
    if (u === "https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels") return Response.json({ models: [{ modelId: "grok-4.7-fast", displayName: "Grok 4.7 Fast" }] })
    if (u.startsWith(base)) return real(url, init)
    throw new Error("the test asked " + u)
  }
}

async function ask(auth, how) {
  const hooks = await CursorAuthPlugin(undefined, how === "option" ? { http: "1.1" } : undefined)
  if (how === "config") await hooks.config({ provider: { cursor: { options: { http: "1.1" } } } })
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: "ses_http11", model: { providerID: "cursor", id: "grok-4.7-fast" }, provider: { info: { id: "cursor" } } }, out)
  const l = await hooks.auth.loader(async () => auth)
  const res = await l.fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: new Headers(out.headers),
    body: JSON.stringify({ model: "grok-4.7-fast", messages: [{ role: "user", content: "fix the bug" }] }),
  })
  const j = await res.json()
  expect([res.status, j.error]).toEqual([200, undefined])
  expect(j.choices[0].message.content).toBe("hi")
}

test("HTTP/1.1 mode is RunSSE plus BidiAppend, and the stream waits on those appends", async () => {
  fakeAPI()
  await ask(fresh(), "option")
  const sse = seen.find((s) => s.path?.endsWith("/agent.v1.AgentService/RunSSE"))
  const append = seen.find((s) => s.path?.endsWith("/aiserver.v1.BidiService/BidiAppend"))
  expect(sse?.version).toBe("1.1")
  expect(sse?.type).toBe("application/connect+proto")
  expect(append?.version).toBe("1.1")
  expect(append?.type).toBe("application/proto")
  expect(seen.find((s) => s.conv)?.conv).toMatch(/^[0-9a-f-]{36}$/)
  expect(seen.find((s) => s.blob)?.blob).toBeGreaterThan(0)
})

test("provider.cursor.options.http selects the same HTTP/1.1 mode", async () => {
  fakeAPI()
  const before = appends.length
  await ask(fresh(), "config")
  expect(appends.length).toBeGreaterThan(before)
  expect(seen.filter((s) => s.path?.endsWith("/RunSSE")).length).toBe(2)
})
