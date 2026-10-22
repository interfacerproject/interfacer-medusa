import type { ExecArgs } from "@medusajs/framework/types"
import { seedMatching } from "../modules/interfacer/build-matching"

export default async function seed({ container }: ExecArgs) {
  const result = await seedMatching(container)
  console.log("PASS seeded structured SYNTHETIC designs/services: " +
    result.designs.length + "/" + result.services.length + " (idempotent; no external data)")
}
