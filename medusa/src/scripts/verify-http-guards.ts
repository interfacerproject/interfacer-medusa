import assert from "node:assert/strict"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { GET, POST, OPTIONS } from "../api/dev/interfacer/listings/route"

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
    await handler({ headers: { origin }, scope, body } as unknown as MedusaRequest,
      res as unknown as MedusaResponse)
    return { status, result, headers }
  }
  try {
    for (const mode of [undefined, "", "other", "fixture-controller-stub"]) {
      for (const env of ["development", "production"]) {
        if (mode === undefined) delete process.env.INTERFACER_AUTH_MODE
        else process.env.INTERFACER_AUTH_MODE = mode
        process.env.NODE_ENV = env
        if (mode === "fixture-controller-stub" && env !== "production") continue
        for (const handler of [GET, POST, OPTIONS]) {
          const response = await invoke(handler, "http://localhost:3104")
          assert.equal(response.status, 403)
          assert.deepEqual(response.result, { reason: "local_fixture_mode_required" })
        }
      }
    }
    process.env.INTERFACER_AUTH_MODE = "fixture-controller-stub"
    process.env.NODE_ENV = "development"
    for (const handler of [GET, POST, OPTIONS]) {
      assert.equal((await invoke(handler, "https://example.org")).status, 403)
    }
    for (const origin of ["http://localhost:3104", "http://localhost:3000"]) {
      const response = await invoke(OPTIONS, origin)
      assert.equal(response.status, 204)
      assert.equal(response.headers["Access-Control-Allow-Origin"], origin)
    }
    for (const body of [null, [], {}, { actingPersonId: "" }, { actingPersonId: 1 }]) {
      assert.equal((await invoke(POST, undefined, body)).status, 400)
    }
    console.log("PASS HTTP handlers: fixture opt-in + production guards (GET/POST/OPTIONS), CORS, body validation; no storage access")
  } finally {
    for (const [key, value] of [
      ["INTERFACER_AUTH_MODE", original.mode], ["NODE_ENV", original.env],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
