// Where the marketplace runs.
// - "local": the opt-in LOCAL DEV stack on a developer machine (fixture mode or
//   live Zenflows), reachable over loopback only.
// - "pilot": a deployed instance. Live Zenflows only, no fixture identities,
//   reachable only through the GUI proxy (shared key), every signed envelope
//   bound to this instance's audience and accepted once.
import { timingSafeEqual } from "node:crypto"

export type CommerceMode = "local" | "pilot"

export function commerceMode(env: NodeJS.ProcessEnv = process.env): CommerceMode | null {
  if (env.INTERFACER_DEPLOYMENT === "pilot") return "pilot"
  if (env.INTERFACER_AUTH_MODE === "signed-envelope-local" && env.NODE_ENV !== "production") return "local"
  return null
}

export function pilotMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return commerceMode(env) === "pilot"
}

// Every marketplace operation (live or standalone) needs one of the two modes.
export function requireCommerceMode(): CommerceMode {
  const mode = commerceMode()
  if (!mode) throw new Error("commerce_mode_required")
  return mode
}

// Fixture identities, the dev signer and standalone listings exist only locally.
export function requireLocalFixture() {
  if (commerceMode() !== "local") throw new Error("local_fixture_mode_required")
}

const AUDIENCE = /^interfacer-commerce:[a-z0-9][a-z0-9.-]{0,120}$/
const FIXTURE_VARS = ["INTERFACER_ZENFLOWS_PROVIDER", "INTERFACER_ZENFLOWS_UNIT", "INTERFACER_ZENFLOWS_RECEIVER",
  "INTERFACER_ZENFLOWS_ADMIN", "INTERFACER_KEYRING_PATH", "INTERFACER_SIGNING_PERSON", "INTERFACER_DEV_STOREFRONT"]

// What a pilot deployment is missing or must not carry. Empty outside pilot.
export function pilotConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.INTERFACER_DEPLOYMENT === undefined) return []
  if (env.INTERFACER_DEPLOYMENT !== "pilot") return ["INTERFACER_DEPLOYMENT must be pilot or unset"]
  const problems: string[] = []
  if (env.NODE_ENV !== "production") problems.push("NODE_ENV=production")
  if (env.INTERFACER_AUTH_MODE) problems.push("INTERFACER_AUTH_MODE must be unset")
  for (const name of FIXTURE_VARS) if (env[name]) problems.push(`${name} must be unset`)
  if (!/^https?:\/\/\S+$/.test(env.INTERFACER_ZENFLOWS_URL ?? "")) problems.push("INTERFACER_ZENFLOWS_URL")
  if (env.INTERFACER_ZENFLOWS_SIGNED_WRITES !== "true") problems.push("INTERFACER_ZENFLOWS_SIGNED_WRITES=true")
  if (!env.INTERFACER_ZENFLOWS_SERVICE_USER || !env.INTERFACER_ZENFLOWS_SERVICE_SEED)
    problems.push("INTERFACER_ZENFLOWS_SERVICE_USER and INTERFACER_ZENFLOWS_SERVICE_SEED")
  if ((env.INTERFACER_PROXY_KEY ?? "").length < 32) problems.push("INTERFACER_PROXY_KEY (32+ characters)")
  if (!AUDIENCE.test(env.INTERFACER_COMMERCE_AUDIENCE ?? ""))
    problems.push("INTERFACER_COMMERCE_AUDIENCE (interfacer-commerce:<instance>)")
  for (const name of ["JWT_SECRET", "COOKIE_SECRET"])
    if ((env[name] ?? "").length < 32) problems.push(`${name} (32+ characters)`)
  return problems
}

export function assertDeploymentConfig(env: NodeJS.ProcessEnv = process.env) {
  const problems = pilotConfigProblems(env)
  if (problems.length) throw new Error("pilot_config_invalid: " + problems.join("; "))
}

// The instance a signed envelope must name. Configured only in pilot; a local
// stack neither advertises nor accepts one.
export function commerceAudience(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.INTERFACER_DEPLOYMENT === "pilot" ? env.INTERFACER_COMMERCE_AUDIENCE : undefined
}

export const PROXY_HEADER = "x-interfacer-proxy-key"

// The GUI proxy proves it is the GUI with a shared key; nothing else may call
// a pilot instance (it is not published on the network either).
export function proxyKeyMatches(value: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.INTERFACER_PROXY_KEY ?? ""
  if (typeof value !== "string" || expected.length < 32) return false
  const a = Buffer.from(value), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
