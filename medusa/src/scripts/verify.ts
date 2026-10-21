import assert from "node:assert/strict"
import type { ExecArgs, IProductModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { Client } from "pg"
import { projectResource, sourceHash } from "../modules/interfacer/project-resource"
import { fixtureControllerCheck, ControllerCheck } from "../modules/interfacer/fixture-controller-check"
import type InterfacerService from "../modules/interfacer/service"
import { INTERFACER_MODULE } from "../modules/interfacer"
import { fixtures } from "./fixtures"

export default async function verify({ container }: ExecArgs) {
  const { resource, passport } = fixtures()
  const service = container.resolve<InterfacerService>(INTERFACER_MODULE)
  const products = container.resolve<IProductModuleService>(Modules.PRODUCT)
  const controller = fixtureControllerCheck(resource.primaryAccountable.id)
  const counts = async () => [
    (await products.listAndCountProducts({}))[1],
    (await service.listAndCountListingBindings({}))[1],
    (await service.listAndCountProjectionIntents({}))[1],
  ]
  const before = await counts()
  const deny = async (name: string, run: () => Promise<unknown>, pattern: RegExp) => {
    await assert.rejects(run, pattern)
    assert.deepEqual(await counts(), before, "denial wrote data")
    console.log("PASS " + name + " (no writes)")
  }
  await deny("foreign controller", () => projectResource(container, resource, passport,
    fixtureControllerCheck("foreign-person")), /authorization_denied/)
  // Extra x-user-id-like claims on a decision cannot override the proven subject.
  const forged: ControllerCheck = async () => ({
    allow: true, subject: "foreign-person", obligations: [],
    policyVersion: "test", permissionEpoch: "test", "x-user-id": resource.primaryAccountable.id,
  })
  await deny("forged subject/header claim", () => projectResource(container, resource, passport, forged), /authorization_denied/)
  await deny("mismatched DPP parent", () => projectResource(container, resource,
    { ...passport, ProductID: "foreign-resource" }, controller), /passport_binding_mismatch/)
  await deny("PDP seam unavailable", () => projectResource(container, resource, passport,
    async () => { throw new Error("simulated timeout") }), /authorization_unavailable/)
  await deny("unknown obligations", () => projectResource(container, resource, passport,
    async r => ({ ...await controller(r), obligations: ["unsupported"] })), /unsupported_obligations/)
  const mode = process.env.INTERFACER_AUTH_MODE
  delete process.env.INTERFACER_AUTH_MODE
  try {
    await deny("fixture opt-in required", () => projectResource(container, resource, passport, controller), /authorization_unavailable/)
  } finally { process.env.INTERFACER_AUTH_MODE = mode }
  const env = process.env.NODE_ENV
  process.env.NODE_ENV = "production"
  try {
    await deny("fixture mode forbidden in production", () => projectResource(container, resource, passport, controller), /authorization_unavailable/)
  } finally {
    if (env === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = env
  }

  const [existing] = await service.listListingBindings({ catalog_resource_id: resource.id })
  const [intent] = await service.listProjectionIntents({ catalog_resource_id: resource.id })
  if (!existing && !intent) {
    await assert.rejects(() => projectResource(container, resource, passport, controller,
      () => { throw new Error("simulated lost response after workflow commit") }), /simulated lost response/)
    assert.equal((await service.listListingBindings({ catalog_resource_id: resource.id })).length, 0)
    assert.equal((await products.listAndCountProducts({}))[1], before[0] + 1)
    console.log("PASS failure injected after product commit, before binding; durable intent retained")
  } else {
    console.log("INFO existing projection/intent: fresh-DB failure injection skipped; retry still tested")
  }

  // Concurrent requests, including recovery of the just-created orphan.
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    projectResource(container, resource, passport, controller)))
  assert.equal(new Set(results.map(r => r.product.id)).size, 1)
  const result = results[0]
  assert.equal(result.product.status, "draft")
  assert.equal(result.product.variants?.length, 1)
  assert.equal(result.product.variants[0].manage_inventory, false)
  assert.deepEqual(Object.keys(result.product.metadata || {}).sort(),
    ["interfacer_dpp_id", "interfacer_intent_id", "interfacer_resource_id"])
  assert.equal(result.product.metadata?.interfacer_dpp_id, passport.ID)
  assert.equal(result.binding.source_snapshot_hash, sourceHash(resource))
  assert.equal(result.binding.passport_snapshot_hash, sourceHash(passport))
  assert.equal((await service.listListingBindings({ catalog_resource_id: resource.id })).length, 1)
  const [savedIntent] = await service.listProjectionIntents({ catalog_resource_id: resource.id })
  assert.equal((await products.listProducts({ handle: savedIntent.product_handle })).length, 1)
  if (!existing && !intent) assert(results.some(r => r.recovered))
  console.log("PASS one draft, one variant, passport reference only, correct module-owned hashes")
  console.log("PASS concurrent retry/recovery: one product ID and one binding")
  const finalCounts = await counts()
  await assert.rejects(() => projectResource(container, { ...resource, name: "Changed" }, passport, controller), /idempotency_conflict/)
  await assert.rejects(() => projectResource(container, resource, { ...passport, ID: "replacement-dpp" }, controller), /idempotency_conflict/)
  await assert.rejects(() => projectResource(container, resource, { ...passport, ProductID: resource.id, privateField: "changed" } as typeof passport, controller), /idempotency_conflict/)
  assert.deepEqual(await counts(), finalCounts)
  assert.equal(sourceHash({ b: 2, a: 1 }), sourceHash({ a: 1, b: 2 }))
  console.log("PASS changed resource, passport ID and passport content rejected; canonical key order stable")

  // Commerce metadata is only a cache: editing it cannot rewrite the binding.
  const originalMetadata = result.product.metadata
  try {
    await products.updateProducts(result.product.id, { metadata: { ...originalMetadata, interfacer_dpp_id: "tampered" } })
    await assert.rejects(() => projectResource(container, resource, passport, controller), /reconciliation_required/)
    const [unchanged] = await service.listListingBindings({ id: result.binding.id })
    assert.equal(unchanged.source_dpp_id, passport.ID)
  } finally {
    await products.updateProducts(result.product.id, { metadata: originalMetadata })
  }
  console.log("PASS tampered product reference requires reconciliation; binding remains authoritative")

  // Exercise both generated module methods and DB protection (our tables only).
  await assert.rejects(() => service.updateListingBindings({ id: result.binding.id,
    catalog_resource_id: "rebound" }), /interfacer_immutable/)
  await assert.rejects(() => service.softDeleteListingBindings(result.binding.id), /interfacer_immutable/)
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await assert.rejects(() => db.query("DELETE FROM interfacer_listing_binding WHERE id = $1", [result.binding.id]), /interfacer_immutable/)
    await assert.rejects(() => db.query("UPDATE interfacer_projection_intent SET source_dpp_id = $1 WHERE id = $2", ["rebound", savedIntent.id]), /interfacer_immutable/)
  } finally { await db.end() }
  console.log("PASS immutable DB rows: update, soft-delete, delete and intent mutation blocked")
  const again = await projectResource(container, resource, passport, controller)
  assert.equal(again.created, false)
  assert.equal(again.binding.id, result.binding.id)
  assert.deepEqual(await counts(), finalCounts)
  console.log("PASS final retry unchanged")
  console.log(JSON.stringify({ product_id: again.product.id, variant_id: again.binding.medusa_variant_id,
    status: again.product.status, binding: again.binding }, null, 2))
  console.log("ALL SPIKE CHECKS PASSED (fixture controller seam; not live PDP proof)")
}
