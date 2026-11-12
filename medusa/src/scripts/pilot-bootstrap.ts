import type { ExecArgs } from "@medusajs/framework/types"
import { seedCommerce } from "../modules/interfacer/commerce-context"
import { commerceMode } from "../modules/interfacer/deployment"

// Run by the image on every start: creates the commerce context (region,
// sales channel, stock location, publishable key) on first boot, then only
// checks it. Nothing to do outside a commerce mode.
export default async function pilotBootstrap({ container }: ExecArgs) {
  if (!commerceMode()) return console.log("[interfacer] no commerce mode set: skipping bootstrap")
  const ctx = await seedCommerce(container)
  console.log(`[interfacer] commerce context ready: region ${ctx.region_id}, sales channel ${ctx.sales_channel_id}`)
}
