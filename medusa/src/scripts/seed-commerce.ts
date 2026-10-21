import type { ExecArgs } from "@medusajs/framework/types"
import { writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { seedCommerce } from "../modules/interfacer/commerce-context"

export default async function seed({ container }: ExecArgs) {
  const commerce = await seedCommerce(container)
  const dir = resolve(process.cwd(), "../.tmp")
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, "commerce-context.json"), JSON.stringify(commerce, null, 2) + "\n")
  console.log(JSON.stringify(commerce, null, 2))
  console.log("Recorded local publishable key + context in .tmp/commerce-context.json")
}
