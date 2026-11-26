import type { ExecArgs } from "@medusajs/framework/types"
import { INTERFACER_MODULE } from "../modules/interfacer"
import type InterfacerService from "../modules/interfacer/service"
import { runDuePayouts } from "../modules/interfacer/settlement"
import { resumePendingRefunds } from "../modules/interfacer/aftersale"

// Operator view of the money (docs/payments-and-aftersale.md): runs the same
// step as the scheduled job once (finish pending refunds, create missing
// payouts, transfer due ones), then lists what still needs attention.
//   docker compose exec medusa interfacer-medusa exec ./src/scripts/money-report.js
export default async function report({ container }: ExecArgs) {
  const refunds = await resumePendingRefunds(container)
  const { created, transferred } = await runDuePayouts(container)
  console.log(JSON.stringify({ refunds_resumed: refunds, payouts_created: created, payouts_transferred: transferred }))
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  for (const status of ["blocked", "held"] as const) {
    const rows = await integration.listPayouts({ status }, { take: 500, order: { release_at: "ASC" } })
    console.log(`payouts ${status}: ${rows.length}`)
    for (const p of rows) console.log(JSON.stringify({ id: p.id, order_id: p.order_id, seller: p.seller_person_id,
      net_cents: p.net_cents, release_at: p.release_at, attempts: p.attempts, last_error: p.last_error }))
  }
  const pending = await integration.listRefunds({ status: "pending" }, { take: 500, order: { created_at: "ASC" } })
  console.log(`refunds pending: ${pending.length}`)
  for (const r of pending) console.log(JSON.stringify({ id: r.id, order_id: r.order_id, amount_cents: r.amount_cents,
    last_error: r.last_error }))
  const open = await integration.listAfterSaleCases({ status: ["requested", "accepted", "returned"] },
    { take: 500, order: { created_at: "ASC" } })
  console.log(`after-sale cases open: ${open.length}`)
  for (const c of open) console.log(JSON.stringify({ id: c.id, order_id: c.order_id, kind: c.kind, status: c.status,
    seller: c.seller_person_id, created_at: c.created_at }))
}
