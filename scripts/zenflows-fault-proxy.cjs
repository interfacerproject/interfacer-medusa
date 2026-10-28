#!/usr/bin/env node
// LOCAL TEST TOOL. Loopback HTTP proxy in front of a local Zenflows that injects
// the failures the milestone outbox must survive, against the REAL registry:
//   lose-response  forward, wait for Zenflows to commit and answer, then drop the
//                  client socket (Medusa sees "socket hang up" after the write)
//   late           drop the client socket at once, forward after delay_ms
//                  (the write commits after Medusa gave up)
//   down           drop the socket without forwarding (nothing is written)
//   reject         answer a GraphQL error without forwarding (nothing is written)
// Control: POST /__fault {"mode","match","times","delay_ms"} adds a rule
// (match: createProcess | raise | produce | transfer | * for any write);
// DELETE /__fault clears rules; GET /__fault lists rules and the request log.
const http = require("node:http")

const PORT = Number(process.env.FAULT_PROXY_PORT || 8100)
const UPSTREAM = new URL(process.env.FAULT_PROXY_UPSTREAM || "http://127.0.0.1:8000")
let rules = []
const log = []

function kind(body) {
  try {
    const { query = "", variables = {} } = JSON.parse(body)
    if (query.includes("createProcess")) return "createProcess"
    if (query.includes("createEconomicEvent")) return String(variables?.e?.action ?? "event")
    return "read"
  } catch { return "unparsed" }
}

function forward(req, body, onResponse) {
  const upstream = http.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: req.url, method: req.method,
    headers: { ...req.headers, host: UPSTREAM.host, "content-length": Buffer.byteLength(body) } }, res => {
    const chunks = []
    res.on("data", c => chunks.push(c))
    res.on("end", () => onResponse(res, Buffer.concat(chunks)))
  })
  upstream.on("error", e => onResponse(null, Buffer.from(String(e))))
  upstream.end(body)
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(value))
}

http.createServer((req, res) => {
  const chunks = []
  req.on("data", c => chunks.push(c))
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8")
    if (req.url === "/__fault") {
      if (req.method === "GET") return json(res, 200, { rules, log: log.slice(-200) })
      if (req.method === "DELETE") { rules = []; return json(res, 200, { rules }) }
      const rule = JSON.parse(body || "{}")
      if (!["lose-response", "late", "down", "reject"].includes(rule.mode)) return json(res, 400, { reason: "bad mode" })
      rules.push({ match: rule.match || "*", mode: rule.mode, times: rule.times ?? 1, delay_ms: rule.delay_ms ?? 3000 })
      return json(res, 200, { rules })
    }
    const k = kind(body)
    const rule = rules.find(r => r.times > 0 && k !== "read" && (r.match === "*" || r.match === k))
    if (rule) rule.times--
    log.push({ at: new Date().toISOString(), kind: k, fault: rule?.mode ?? null })
    if (rule?.mode === "down") return req.socket.destroy()
    if (rule?.mode === "reject") return json(res, 200, { data: null, errors: [{ message: "fault-proxy: injected rejection" }] })
    if (rule?.mode === "late") {
      req.socket.destroy()
      return setTimeout(() => forward(req, body, () => {}), rule.delay_ms)
    }
    forward(req, body, (upstreamRes, payload) => {
      if (rule?.mode === "lose-response" || !upstreamRes) return req.socket.destroy()
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
      res.end(payload)
    })
  })
}).listen(PORT, "127.0.0.1", () => console.log(`zenflows fault proxy on http://127.0.0.1:${PORT} -> ${UPSTREAM.href}`))
