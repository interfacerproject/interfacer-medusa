import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowStorefront } from "../../../../../storefront/dev"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowStorefront(req, res)) return
  const types: Record<string, string> = { "app.js": "application/javascript", "style.css": "text/css" }
  if (!Object.prototype.hasOwnProperty.call(types, req.params.id)) { res.status(404).end(); return }
  res.type(types[req.params.id]).send(readFileSync(resolve(__dirname, "../../../../../storefront", req.params.id), "utf8"))
}
