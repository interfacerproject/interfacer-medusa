#!/usr/bin/env node
// LOCAL TEST TOOL for live mode: real Zenflows People with fresh Ed25519 keys
// (registered as their eddsaPublicKey, base58 like keypairoom), their own
// resources, and P6a envelopes signed with THEIR key. Private keys stay in
// .tmp/live-actors.json (0600); they are disposable local test identities.
//   create <alias>                                  -> {id,user,...}
//   raise <alias> <Design|Service|Product> <name> [qty] -> {resource_id}
//   sign <alias> <op> <params_json>                 -> base64url header
//   call <alias> <query> [variables_json]           -> data (a Zenflows call signed by alias)
//   zsign <alias> <body>                            -> zenflows-sign of an exact body (relay)
// With Zenflows GQL_AUTH_CALLS=true every call is signed (zenflows-user +
// zenflows-sign over the body without spaces); createPerson uses ZENFLOWS_ADMIN.
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { canonicalOperation } = require("../medusa/src/modules/interfacer/envelope-canonical.ts")

const ROOT = path.resolve(__dirname, "..")
const STORE = path.join(ROOT, ".tmp/live-actors.json")
const ZENFLOWS = process.env.ZENFLOWS_DIRECT || "http://127.0.0.1:8000/api"

function base58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
  const digits = []
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) { carry += digits[i] * 256; digits[i] = carry % 58; carry = Math.floor(carry / 58) }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58) }
  }
  let leading = ""
  for (const byte of bytes) { if (byte !== 0) break; leading += "1" }
  return leading + digits.reverse().map(d => alphabet[d]).join("")
}
const load = () => (fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {})
function save(all) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true })
  fs.writeFileSync(STORE, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 })
}
// Same serializer as Medusa's zenflowsBody(): one-line query, canonical JSON.
function body(query, variables) {
  return JSON.stringify({ query: query.replace(/\s+/g, " ").trim(), variables })
}
function signBody(text, a) {
  if (!/^[\x20-\x5b\x5d-\x7e]*$/.test(text)) throw new Error("non-canonical Zenflows body")
  return crypto.sign(null, Buffer.from(text.replace(/ /g, ""), "utf8"), a.pkcs8).toString("base64")
}
// Zenflows ignores zenflows-user/-sign whenever zenflows-admin is present, so
// the admin key goes ONLY on admin-only fields (createPerson).
async function gql(query, variables = {}, as, admin = false) {
  const text = body(query, variables)
  const headers = { "content-type": "application/json" }
  if (admin && process.env.ZENFLOWS_ADMIN) headers["zenflows-admin"] = process.env.ZENFLOWS_ADMIN
  else if (as) Object.assign(headers, { "zenflows-user": as.user, "zenflows-sign": signBody(text, as) })
  const res = await fetch(ZENFLOWS, { method: "POST", headers, body: text })
  const json = await res.json()
  if (json.errors?.length || !json.data) throw new Error(JSON.stringify(json.errors ?? json))
  return json.data
}
function actor(alias) {
  const a = load()[alias]
  if (!a) throw new Error("unknown actor " + alias + "; create it first")
  return a
}

async function create(alias) {
  const { privateKey } = crypto.generateKeyPairSync("ed25519")
  const jwk = privateKey.export({ format: "jwk" })
  const user = `live${Date.now()}${alias.replace(/[^a-z0-9]/gi, "").toLowerCase()}`
  const email = `${user}@market.invalid`
  const publicKey = base58(Buffer.from(jwk.x, "base64url"))
  const data = await gql(`mutation($p: PersonCreateParams!) { createPerson(person: $p) { agent { id } } }`,
    { p: { name: `Live ${alias}`, user, email, eddsaPublicKey: publicKey } }, undefined, true)
  const entry = { id: data.createPerson.agent.id, user, email, publicKey,
    seed: base58(Buffer.from(jwk.d, "base64url")), pkcs8: privateKey.export({ type: "pkcs8", format: "pem" }) }
  save({ ...load(), [alias]: entry })
  return { alias, ...entry, pkcs8: undefined }
}

async function raise(alias, specName, name, qty = "1") {
  const a = actor(alias)
  const v = (await gql(`{ instanceVariables { specs { specProjectDesign { id } specProjectService { id }
    specProjectProduct { id } } units { unitOne { id } } } }`, {}, a)).instanceVariables
  const spec = { Design: v.specs.specProjectDesign.id, Service: v.specs.specProjectService.id,
    Product: v.specs.specProjectProduct.id }[specName]
  if (!spec) throw new Error("spec must be Design, Service or Product")
  const data = await gql(`mutation($e: EconomicEventCreateParams!, $r: EconomicResourceCreateParams!) {
    createEconomicEvent(event: $e, newInventoriedResource: $r) { economicEvent { resourceInventoriedAs { id } } } }`, {
    e: { action: "raise", provider: a.id, receiver: a.id, resourceConformsTo: spec,
      resourceQuantity: { hasNumericalValue: Number(qty), hasUnit: v.units.unitOne.id },
      hasPointInTime: new Date().toISOString(), note: "live marketplace test resource" },
    r: { name, note: "live marketplace test resource" },
  }, a)
  return { resource_id: data.createEconomicEvent.economicEvent.resourceInventoriedAs.id }
}

function sign(alias, op, params) {
  const a = actor(alias)
  const envelope = { op, params: JSON.parse(params), person_id: a.id,
    nonce: crypto.randomBytes(16).toString("hex"), issued_at: new Date().toISOString() }
  const signature = crypto.sign(null, Buffer.from(canonicalOperation(envelope), "utf8"), a.pkcs8).toString("base64")
  return Buffer.from(JSON.stringify({ envelope, signature })).toString("base64url")
}

async function call(alias, query, variables = "{}") {
  return gql(query, JSON.parse(variables), actor(alias))
}

const [cmd, ...args] = process.argv.slice(2)
Promise.resolve()
  .then(() => (cmd === "create" ? create(...args) : cmd === "raise" ? raise(...args) : cmd === "sign" ? sign(...args)
    : cmd === "call" ? call(...args) : cmd === "zsign" ? signBody(args[1], actor(args[0])) : null))
  .then(out => {
    if (out === null) throw new Error("usage: create <alias> | raise <alias> <spec> <name> [qty] | sign <alias> <op> <params>")
    process.stdout.write((typeof out === "string" ? out : JSON.stringify(out)) + "\n")
  })
  .catch(e => { console.error(e.message); process.exit(1) })
