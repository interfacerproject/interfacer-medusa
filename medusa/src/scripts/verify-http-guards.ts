import assert from "node:assert/strict"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { GET, POST, OPTIONS } from "../api/dev/interfacer/listings/route"
import { POST as seed, OPTIONS as seedOptions } from "../api/dev/interfacer/commerce/route"
import { POST as publish, OPTIONS as publishOptions } from "../api/dev/interfacer/listings/[id]/publish/route"
import { POST as identity, OPTIONS as identityOptions } from "../api/dev/interfacer/identity/route"
import { POST as checkout, OPTIONS as checkoutOptions } from "../api/dev/interfacer/listings/[id]/checkout/route"
import { POST as deliver, OPTIONS as deliverOptions } from "../api/dev/interfacer/orders/[id]/deliver/route"
import { GET as receipts, OPTIONS as receiptOptions } from "../api/dev/interfacer/receipts/route"
import { GET as designs, OPTIONS as designOptions } from "../api/dev/interfacer/designs/route"
import { GET as services, OPTIONS as serviceOptions } from "../api/dev/interfacer/services/route"
import { POST as match, OPTIONS as matchOptions } from "../api/dev/interfacer/match/route"
import { validatePriceEUR } from "../modules/interfacer/publish-listing"

export async function verifyHttpGuards() {
  const original = { mode: process.env.INTERFACER_AUTH_MODE, env: process.env.NODE_ENV }
  // Any dependency resolution would indicate a guard reached storage.
  const scope = { resolve: () => { throw new Error("guard reached storage") } }
  const invoke = async (handler: typeof GET, origin?: string, body?: unknown) => {
    let status = 200
    let result: unknown
    const headers: Record<string, string> = {}
    const res = {
      setHeader: (key: string, value: string) => { headers[key] = value },
      vary: () => {},
      status: (value: number) => { status = value; return res },
      json: (value: unknown) => { result = value; return res },
      end: () => res,
    }
    await handler({ headers: { origin }, scope, body, params: { id: "unknown" } } as unknown as MedusaRequest,
      res as unknown as MedusaResponse)
    return { status, result, headers }
  }
  const guarded = [GET, POST, OPTIONS, seed, seedOptions, publish, publishOptions,
    identity, identityOptions, checkout, checkoutOptions, deliver, deliverOptions, receipts, receiptOptions,
    designs, designOptions, services, serviceOptions, match, matchOptions]
  try {
    for (const value of [undefined, null, "19.95", NaN, Infinity, 0, -1, 1.001, 1000001]) {
      assert.throws(() => validatePriceEUR(value), /invalid_price/)
    }
    for (const value of [0.01, 19.95, 20, 1000000]) validatePriceEUR(value)
    for (const mode of [undefined, "", "other", "fixture-controller-stub"]) {
      for (const env of ["development", "production"]) {
        if (mode === undefined) delete process.env.INTERFACER_AUTH_MODE
        else process.env.INTERFACER_AUTH_MODE = mode
        process.env.NODE_ENV = env
        if (mode === "fixture-controller-stub" && env !== "production") continue
        for (const handler of guarded) {
          const response = await invoke(handler, "http://localhost:3104")
          assert.equal(response.status, 403)
          assert.deepEqual(response.result, { reason: "local_fixture_mode_required" })
        }
      }
    }
    process.env.INTERFACER_AUTH_MODE = "fixture-controller-stub"
    process.env.NODE_ENV = "development"
    for (const handler of guarded) {
      assert.equal((await invoke(handler, "https://example.org")).status, 403)
    }
    for (const origin of ["http://localhost:3104", "http://localhost:3000"]) {
      for (const handler of [OPTIONS, seedOptions, publishOptions, identityOptions, checkoutOptions, deliverOptions, receiptOptions, designOptions, serviceOptions, matchOptions]) {
        const response = await invoke(handler, origin)
        assert.equal(response.status, 204)
        assert.equal(response.headers["Access-Control-Allow-Origin"], origin)
      }
    }
    for (const body of [null, [], {}, { actingPersonId: "" }, { actingPersonId: 1 }]) {
      assert.equal((await invoke(POST, undefined, body)).status, 400)
    }
    for (const body of [null, [], {}, { priceEUR: "19.95" }, { priceEUR: 0 }, { priceEUR: 19.95, product_id: "untrusted" }]) {
      assert.equal((await invoke(publish, undefined, body)).status, 400)
    }
    for (const body of [null, [], {}, { designId: "" }, { designId: 1 },
      { designId: "ok", priceEUR: 0.01 }, { designId: "ok", serviceId: "untrusted" }]) {
      assert.equal((await invoke(match, undefined, body)).status, 400)
    }
    console.log("PASS HTTP handlers (including P1/P2/P3/P4 commerce/publish/identity/stock/delivery/receipts/matching) + EUR price validation: fixture opt-in + production guards (GET/POST/OPTIONS), CORS, body validation; no storage access")
  } finally {
    for (const [key, value] of [
      ["INTERFACER_AUTH_MODE", original.mode], ["NODE_ENV", original.env],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
