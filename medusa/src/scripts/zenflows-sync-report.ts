import type { ExecArgs } from "@medusajs/framework/types"
import { INTERFACER_MODULE } from "../modules/interfacer"
import type InterfacerService from "../modules/interfacer/service"
import { syncView } from "../modules/interfacer/zenflows-outbox"

// Operator view of the Zenflows outbox (docs/deploy-pilot.md): every row that
// is not done, oldest first, with its marker for searching Zenflows notes.
//   docker compose exec medusa interfacer-medusa exec ./src/scripts/zenflows-sync-report.js
export default async function report({ container }: ExecArgs) {
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  for (const status of ["blocked", "pending"] as const) {
    const rows = await integration.listZenflowsSyncs({ status }, { take: 500, order: { created_at: "ASC" } })
    console.log(`${status}: ${rows.length}`)
    for (const row of rows) console.log(JSON.stringify({ order_id: row.order_id, marker: row.marker,
      created_at: row.created_at, ...syncView(row as any) }))
  }
}
