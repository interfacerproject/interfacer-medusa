import type { MedusaContainer } from "@medusajs/framework/types"
import { INTERFACER_MODULE } from "../modules/interfacer"
import type InterfacerService from "../modules/interfacer/service"
import { runDueZenflowsSyncs } from "../modules/interfacer/zenflows-outbox"
import { commerceMode } from "../modules/interfacer/deployment"

// Restart/outage recovery for the durable milestone outbox: advances due pending
// rows (backoff honoured, one advisory lock per row). No-op when standalone.
export default async function interfacerZenflowsSync(container: MedusaContainer) {
  if (!commerceMode()) return
  const advanced = await runDueZenflowsSyncs(container.resolve<InterfacerService>(INTERFACER_MODULE))
  if (advanced) console.log(`[interfacer] zenflows outbox: advanced ${advanced} due sync(s)`)
}

export const config = { name: "interfacer-zenflows-sync", schedule: "* * * * *" }
