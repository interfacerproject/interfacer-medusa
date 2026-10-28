import assert from "node:assert/strict"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { GET as page } from "../api/dev/store/route"
import { GET as assets } from "../api/dev/store/assets/[id]/route"
import { GET as config } from "../api/dev/store/config/route"
import { POST as sign } from "../api/dev/store/sign/route"
import { POST as capture } from "../api/dev/store/capture/route"
import { GET as challenge, POST as session } from "../api/dev/store/session/route"
import { POST as prepare } from "../api/dev/store/prepare/route"
import { allowStorefront } from "../storefront/dev"

export async function verifyStorefrontGuards() {
  const keys = ["INTERFACER_AUTH_MODE", "INTERFACER_DEV_STOREFRONT", "NODE_ENV"] as const
  const before = keys.map(key => process.env[key])
  try {
    const invoke = async (handler: ((req: MedusaRequest, res: MedusaResponse) => Promise<unknown>) | null, overrides: Record<string, unknown> = {}, remote = "127.0.0.1") => {
      let status = 200
      const res = { setHeader() {}, vary() {}, status(value: number) { status = value; return res }, json() { return res } }
      const req = { headers: { host: "localhost:9000", ...overrides }, socket: { remoteAddress: remote },
        scope: { resolve() { throw new Error("guard reached storage") } } }
      if (handler) await handler(req as unknown as MedusaRequest, res as unknown as MedusaResponse)
      else allowStorefront(req as unknown as MedusaRequest, res as unknown as MedusaResponse)
      return status
    }
    for (const handler of [page, assets, config, sign, capture, challenge, session, prepare]) {
      for (const env of ["development", "production"]) {
        for (const mode of ["disabled", "signed-envelope-local"]) {
          for (const flag of ["false", "true"]) {
            process.env.NODE_ENV = env
            process.env.INTERFACER_AUTH_MODE = mode
            process.env.INTERFACER_DEV_STOREFRONT = flag
            if (env !== "production" && mode === "signed-envelope-local" && flag === "true") continue
            assert.equal(await invoke(handler), 403)
          }
        }
      }
      process.env.NODE_ENV = "development"
      process.env.INTERFACER_AUTH_MODE = "signed-envelope-local"
      process.env.INTERFACER_DEV_STOREFRONT = "true"
      for (const headers of [{ host: "evil.test:9000" }, { origin: "https://evil.test" },
        { origin: "http://localhost:3000" },
        { host: "localhost:9000", origin: "http://127.0.0.1:9000" }]) {
        assert.equal(await invoke(handler, headers), 403)
      }
      assert.equal(await invoke(handler, {}, "192.0.2.1"), 403)
    }
    assert.equal(await invoke(null, { origin: "http://localhost:9000" }), 200)
    assert.equal(await invoke(null, { host: "127.0.0.1:9000", origin: "http://127.0.0.1:9000" }), 200)
    // Top-level navigation from another page has sec-fetch-site:cross-site but
    // no Origin; the storefront intentionally permits it (dev.ts rationale).
    assert.equal(await invoke(null, { "sec-fetch-site": "cross-site" }), 200)
    console.log("PASS storefront/session/prepare guards: production, disabled flag/mode, remote socket, Host/rebinding and foreign Origin refused before files/storage; origin-less navigation allowed")
  } finally {
    keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i] })
  }
}
