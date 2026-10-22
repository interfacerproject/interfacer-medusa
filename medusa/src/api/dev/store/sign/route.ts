// LOUDLY DEV-ONLY: signs with the P6a helper's disposable LOCAL fixture keys.
// This is not a customer wallet, supplier login or production authorization.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowStorefront, demo, demoSigningOperation } from "../../../../storefront/dev"
import { signLocalOperation } from "../../../../scripts/sign-local-operation"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowStorefront(req, res)) return
  const { op, params, person } = await demoSigningOperation(req, demo())
  const auth = signLocalOperation(op, params, person)
  res.json({ label: "LOCAL DEV SIGNER — disposable fixture/dev keys, not production",
    auth, header: Buffer.from(JSON.stringify(auth)).toString("base64url") })
}
