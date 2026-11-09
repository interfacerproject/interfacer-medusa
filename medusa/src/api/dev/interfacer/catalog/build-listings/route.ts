import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowLocalRequest } from "../../local-guard"
import { INTERFACER_MODULE } from "../../../../../modules/interfacer"
import type InterfacerService from "../../../../../modules/interfacer/service"
import { authFromHeader, AUTH_HEADER } from "../../../../../modules/interfacer/signed-envelope"
import { listBuildListings, registerBuildListing } from "../../../../../modules/interfacer/build-listing"

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/

export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  res.status(204).end()
}

// Current listings (latest revision, live service + design, signer still owns
// the service). Optional exact filters; paused ones only with include_inactive=1.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  const q = req.query as Record<string, unknown>
  const id = (key: string) => {
    const v = q[key]
    if (v === undefined) return undefined
    if (typeof v !== "string" || !ID.test(v)) return null
    return v
  }
  const [service, design, provider] = [id("service"), id("design"), id("provider")]
  if (service === null || design === null || provider === null ||
      (q.include_inactive !== undefined && q.include_inactive !== "1")) {
    res.status(400).json({ reason: "invalid_build_listing_query" })
    return
  }
  const listings = await listBuildListings(req.scope.resolve<InterfacerService>(INTERFACER_MODULE),
    { service, design, provider, include_inactive: q.include_inactive === "1" })
  res.json({ listings })
}

// Body = the signed params; the signer must own the registered service.
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  const result = await registerBuildListing(req.scope, req.body, authFromHeader(req.headers[AUTH_HEADER]))
  res.status(result.created ? 201 : 200).json(result)
}
