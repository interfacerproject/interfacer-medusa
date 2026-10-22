#!/usr/bin/env node
// LOCAL DEMO KEYS ONLY. Never import these fixture secrets into a deployment.
// Node 24's built-in TS stripping loads the SAME canonicalizer as the verifier.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '..')
const { canonicalOperation } = require('../medusa/src/modules/interfacer/envelope-canonical.ts')
const publicPath = process.env.INTERFACER_KEYRING_PATH || path.join(root, '.tmp/auth-public-keyring.json')
const privatePath = path.join(root, '.tmp/auth-private-keyring.json')
function read(p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }
function initialize() {
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true })
  for (const [target, fixture] of [[publicPath, 'auth-public-keyring.json'], [privatePath, 'auth-private-keyring.json']]) {
    if (!fs.existsSync(target)) fs.writeFileSync(target, JSON.stringify(read(path.join(root, 'docs/fixtures', fixture)), null, 2) + '\n', { mode: 0o600 })
  }
}
function seedPerson(person) {
  initialize()
  const pub = read(publicPath), priv = read(privatePath)
  if (!Object.hasOwn(pub, person)) {
    const pair = crypto.generateKeyPairSync('ed25519')
    pub[person] = pair.publicKey.export({ type: 'spki', format: 'pem' })
    priv[person] = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
    fs.writeFileSync(publicPath, JSON.stringify(pub, null, 2) + '\n')
    fs.writeFileSync(privatePath, JSON.stringify(priv, null, 2) + '\n', { mode: 0o600 })
  }
}
function signOperation(op, params, person, keyPerson = person) {
  initialize()
  const priv = read(privatePath)
  if (!Object.hasOwn(priv, keyPerson)) throw new Error('Unknown LOCAL signing Person; explicitly --seed-person first')
  const envelope = { op, params, person_id: person, nonce: crypto.randomBytes(16).toString('hex'), issued_at: new Date().toISOString() }
  return { envelope, signature: crypto.sign(null, Buffer.from(canonicalOperation(envelope), 'utf8'), priv[keyPerson]).toString('base64') }
}
module.exports = { signOperation, seedPerson }
if (require.main === module) {
  const [op, person, params, keyPerson] = process.argv.slice(2)
  if (op === '--seed-person') { seedPerson(person); process.exit(0) }
  if (!op || !person || !params) throw new Error('Usage: npm run sign -- OP PERSON PARAMS_JSON [KEY_PERSON]; or --seed-person PERSON')
  const auth = signOperation(op, JSON.parse(params), person, keyPerson)
  process.stdout.write(JSON.stringify(auth) + '\n')
}
