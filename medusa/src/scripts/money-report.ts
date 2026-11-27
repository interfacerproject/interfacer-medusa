import type { ExecArgs } from "@medusajs/framework/types"
import { INTERFACER_MODULE } from "../modules/interfacer"
import type InterfacerService from "../modules/interfacer/service"
import { AUTHORIZATION_DAYS, cancelLapsedAuthorizations } from "../modules/interfacer/settlement"
import { resumePendingRefunds } from "../modules/interfacer/aftersale"

// Operator view of the money (docs/payments-and-aftersale.md): runs the same
// step as the scheduled job once (finish pending refunds, cancel orders whose
// payment authorization lapsed), then lists what still needs attention.
//   docker compose exec medusa interfacer-medusa exec ./src/scripts/money-report.js
// Argument lapse-check-all also asks Stripe about authorizations younger than 6 days
// (normally skipped: Stripe only releases them after 7).
export default async function report({ container, args }: ExecArgs) {
  const refunds = await resumePendingRefunds(container)
  const later = new Date(Date.now() + AUTHORIZATION_DAYS * 86_400_000)
  const lapsed = await cancelLapsedAuthorizations(container, args?.includes("lapse-check-all") ? later : new Date())
  console.log(JSON.stringify({ refunds_resumed: refunds, lapsed_canceled: lapsed }))
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
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
