import assert from "node:assert/strict"
import type { ExecArgs } from "@medusajs/framework/types"
import { Client } from "pg"
import { INTERFACER_MODULE } from "../modules/interfacer"
import type InterfacerService from "../modules/interfacer/service"
import { matchDesign, seedMatching } from "../modules/interfacer/build-matching"
import { formBuildQuote, termsHash } from "../modules/interfacer/matching"
import { designs, services } from "../modules/interfacer/matching-fixtures"
import { verifyHttpGuards } from "./verify-http-guards"

export default async function verify({ container }: ExecArgs) {
  await verifyHttpGuards()
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  const before = [(await integration.listAndCountDesigns({}))[1], (await integration.listAndCountServices({}))[1]]
  assert.deepEqual(await seedMatching(container), await seedMatching(container))
  assert.deepEqual([(await integration.listAndCountDesigns({}))[1], (await integration.listAndCountServices({}))[1]], before)
  const terms = formBuildQuote(designs[0], services[0])
  const [quote] = await integration.listBuildQuotes({ quote_hash: terms.quote_hash })
  assert(quote)
  assert.equal(termsHash(quote.snapshot), quote.quote_hash)
  await assert.rejects(() => integration.createBuildQuotes(terms), /unique|duplicate|already exists/i)

  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    for (const statement of [
      'UPDATE interfacer_build_quote SET total_price_cents=1 WHERE id=$1',
      "UPDATE interfacer_build_quote SET snapshot='{}'::jsonb WHERE id=$1",
      'UPDATE interfacer_build_quote SET deleted_at=now() WHERE id=$1',
      'DELETE FROM interfacer_build_quote WHERE id=$1',
    ]) await assert.rejects(() => db.query(statement, [quote.id]), /immutable/i)
  } finally { await db.end() }
  assert.deepEqual(await integration.retrieveBuildQuote(quote.id), quote)
  console.log("PASS seed idempotency, quote hash uniqueness and DB immutable price/snapshot/update/soft-delete/delete.")

  // Changing the service later forms NEW terms, never edits the original quote.
  const [service] = await integration.listServices({ id: services[0].id })
  try {
    await integration.updateServices({ id: service.id, base_price_cents: service.base_price_cents + 100 })
    const next = await matchDesign(container, designs[0].id)
    const changed = next.matches.find(m => m.service.id === service.id)!.quote
    assert.notEqual(changed.id, quote.id)
    assert.notEqual(changed.quote_hash, quote.quote_hash)
    assert.equal(changed.total_price_cents, quote.total_price_cents + 100)
    assert.deepEqual(await integration.retrieveBuildQuote(quote.id), quote)
  } finally {
    await integration.updateServices({ id: service.id, base_price_cents: service.base_price_cents })
  }
  const restored = await matchDesign(container, designs[0].id)
  assert.equal(restored.matches.find(m => m.service.id === service.id)!.quote.id, quote.id)
  console.log("PASS changed service price => new quote/hash; old quote unchanged and still retrievable by ID for P5.")

  const mode = process.env.INTERFACER_AUTH_MODE
  process.env.INTERFACER_AUTH_MODE = "disabled"
  try {
    await assert.rejects(() => seedMatching(container), /local_fixture_mode_required/)
    await assert.rejects(() => matchDesign(container, designs[0].id), /local_fixture_mode_required/)
  } finally { process.env.INTERFACER_AUTH_MODE = mode }
  console.log("ALL P4 CHECKS PASSED (structured synthetic capabilities, not tags or external manufacturability proof)")
}
