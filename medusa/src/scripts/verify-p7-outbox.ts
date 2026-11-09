import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import type { ExecArgs } from "@medusajs/framework/types"
import { INTERFACER_MODULE } from "../modules/interfacer"
import type InterfacerService from "../modules/interfacer/service"
import { milestonePayloadHash } from "../modules/interfacer/zenflows-sync"

// P7: receipt + outbox row are one transaction. A sync insert that fails (here:
// a duplicate marker) must leave no receipt behind, so no remote write can ever
// exist without its local record. Uses an unused order id; nothing persists.
export default async function verify({ container }: ExecArgs) {
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  const [existing] = await integration.listZenflowsSyncs({}, { take: 1 })
  assert.ok(existing, "run a live milestone first: an existing sync marker is needed")
  const order_id = "order_p7_atomic_" + randomBytes(6).toString("hex")
  const payload = { ...(existing.payload as any), note: "p7 atomicity probe " + order_id }
  await assert.rejects(integration.createReceiptWithSync({
    action: "transfer", provider_id: "p7", receiver_id: "p7", resource_id: "p7", dpp_id: "p7",
    order_id, quantity: 1, has_point_in_time: new Date(), zenflows_event_id: null,
  } as any, { order_id, marker: existing.marker, payload, payload_hash: milestonePayloadHash(payload),
    status: "pending", attempts: 0, next_attempt_at: new Date() }))
  assert.equal((await integration.listReaReceipts({ order_id })).length, 0, "receipt must roll back with its sync row")
  assert.equal((await integration.listZenflowsSyncs({ order_id })).length, 0)
  console.log(`PASS P7 ATOMIC: failed outbox insert (duplicate marker) rolled back its receipt; order=${order_id} has 0 receipts / 0 syncs`)
}
