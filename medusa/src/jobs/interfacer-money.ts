import type { MedusaContainer } from "@medusajs/framework/types"
import { commerceMode } from "../modules/interfacer/deployment"
import { cancelLapsedAuthorizations } from "../modules/interfacer/settlement"
import { resumePendingRefunds } from "../modules/interfacer/aftersale"

// Money recovery: finishes refunds an outage interrupted, and cancels Stripe
// stock orders whose authorization lapsed before delivery (the unit is for
// sale again). Every 5 minutes.
export default async function interfacerMoney(container: MedusaContainer) {
  if (!commerceMode()) return
  const refunds = await resumePendingRefunds(container)
  const lapsed = await cancelLapsedAuthorizations(container)
  if (refunds || lapsed) console.log(`[interfacer] money: ${refunds} refund(s) resumed, ${lapsed} lapsed order(s) canceled`)
}

export const config = { name: "interfacer-money", schedule: "*/5 * * * *" }
