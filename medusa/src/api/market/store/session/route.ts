import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketStorefront } from "../../../market-guard"
import { buyerChallenges } from "../../../../modules/interfacer/buyer-challenges"
import { createBuyerSession } from "../../../../modules/interfacer/buyer-session"
import { authFromHeader, AUTH_HEADER } from "../../../../modules/interfacer/signed-envelope"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketStorefront(req, res)) return
  res.setHeader("Cache-Control", "no-store")
  const person = req.query.person
  if (typeof person !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(person))
    return res.status(400).json({ reason: "invalid_zenflows_person" })
  try { res.json({ challenge: buyerChallenges.issue(person) }) }
  catch { res.status(429).json({ reason: "buyer_challenge_capacity" }) }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketStorefront(req, res)) return
  res.setHeader("Cache-Control", "no-store")
  res.json(await createBuyerSession(req.scope, authFromHeader(req.headers[AUTH_HEADER])))
}
