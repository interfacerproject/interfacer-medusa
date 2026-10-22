// Real Ed25519 proof; LOCAL key/controller resolver, NOT a live Zenflows PDP.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { IProductModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { allowLocalRequest } from "../local-guard"
import { INTERFACER_MODULE } from "../../../../modules/interfacer"
import type InterfacerService from "../../../../modules/interfacer/service"
import { authFromHeader, AUTH_HEADER, type Resource } from "../../../../modules/interfacer/signed-envelope"
import { projectResource, type Passport } from "../../../../modules/interfacer/project-resource"


export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  res.status(204).end()
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  const body = req.body as { resource?: Resource; dpp?: Passport } | null
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      !body.resource || !body.dpp) {
    res.status(400).json({ reason: "invalid_body: resource and dpp required" })
    return
  }
  try {
    // Same signed entrypoint as the CLI. Legacy actingPersonId is NOT authority.
    // No caller-supplied policy,
    // operation key, product IDs, workflow options, or failure injection.
    const { created, product, binding } = await projectResource(
      req.scope, body.resource as Resource, body.dpp as Passport,
      authFromHeader(req.headers[AUTH_HEADER])
    )
    res.status(created ? 201 : 200).json({
      created,
      product_id: product.id,
      variant_id: binding.medusa_variant_id,
      status: product.status,
      binding,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : ""
    const code = reason.split(":")[0]
    const statuses: Record<string, number> = {
      invalid_source: 400,
      passport_binding_mismatch: 400,
      authorization_denied: 403,
      idempotency_conflict: 409,
      reconciliation_required: 409,
    }
    if (!Object.prototype.hasOwnProperty.call(statuses, code)) throw error
    res.status(statuses[code]).json({ reason })
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  const integration = req.scope.resolve<InterfacerService>(INTERFACER_MODULE)
  const products = req.scope.resolve<IProductModuleService>(Modules.PRODUCT)
  const listings = []
  // Don't silently truncate at the module service's default page size.
  for (let skip = 0; ; skip += 100) {
    const bindings = await integration.listListingBindings({}, {
      take: 100, skip, order: { id: "ASC" },
    })
    for (const binding of bindings) {
      const product = await products.retrieveProduct(binding.medusa_product_id, { relations: ["variants"] })
      listings.push({ binding, product })
    }
    if (bindings.length < 100) break
  }
  res.json({ listings })
}
