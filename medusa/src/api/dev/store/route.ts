import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowStorefront } from "../../../storefront/dev"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowStorefront(req, res)) return
  res.type("html").send(readFileSync(resolve(__dirname, "../../../storefront/index.html"), "utf8"))
}
