import type { MedusaContainer } from "@medusajs/framework/types"
import { commerceMode } from "../modules/interfacer/deployment"
import { runDuePayouts } from "../modules/interfacer/settlement"
import { resumePendingRefunds } from "../modules/interfacer/aftersale"

// Money recovery and release: finishes refunds an outage interrupted, writes
// payouts a crash skipped, and transfers sellers' shares that are due.
export default async function interfacerPayouts(container: MedusaContainer) {
  if (!commerceMode()) return
  const refunds = await resumePendingRefunds(container)
  const { created, transferred } = await runDuePayouts(container)
  if (refunds || created || transferred)
    console.log(`[interfacer] money: ${refunds} refund(s) resumed, ${created} payout(s) created, ${transferred} transferred`)
}

export const config = { name: "interfacer-payouts", schedule: "*/5 * * * *" }
