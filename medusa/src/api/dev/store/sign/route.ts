// LOUDLY DEV-ONLY: signs with the P6a helper's disposable LOCAL fixture keys.
// This is not a customer wallet, supplier login or production authorization.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowStorefront, buyerScene, demo, demoSigningOperation } from "../../../../storefront/dev"
import { signLocalOperation } from "../../../../scripts/sign-local-operation"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowStorefront(req, res)) return
  const { op, params, person } = await demoSigningOperation(req, await buyerScene(req))
  // A real buyer must use their own browser wallet; this route only ever signs
  // the original disposable fixture actors. Never add their key to a local file.
  if (person !== demo().buyer_person_id && !["commerce.order.deliver", "commerce.order.produce"].includes(op)) {
    res.status(403).json({ reason: "buyer_wallet_signature_required" })
    return
  }
  const auth = signLocalOperation(op, params, person)
  res.json({ label: "LOCAL DEV SIGNER — disposable fixture/dev keys, not production",
    auth, header: Buffer.from(JSON.stringify(auth)).toString("base64url") })
}
