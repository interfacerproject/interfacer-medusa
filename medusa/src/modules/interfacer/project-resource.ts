import { createHash } from "node:crypto"
import type { MedusaContainer, IProductModuleService, ProductDTO } from "@medusajs/framework/types"
import { Modules, ProductStatus } from "@medusajs/framework/utils"
import { createProductsWorkflow } from "@medusajs/medusa/core-flows"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"
import { verifySignedOperation, type Resource } from "./signed-envelope"
import { requireLocalCommerce } from "./commerce-context"

export interface Passport { ID: string; ProductID: string }

// Stable JSON object-key order; array order remains significant. Versioned here,
// not claimed to be a Zenroom signing format.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"
  const obj = value as Record<string, unknown>
  return "{" + Object.keys(obj).sort().map(k => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}"
}
export function sourceHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function required(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 1000) {
    throw new Error("invalid_source")
  }
}

export async function projectResource(
  container: MedusaContainer,
  resource: Resource,
  passport: Passport,
  auth: unknown,
  // Failure injection is in-process only, used by the CLI acceptance test.
  afterProduct?: () => void
) {
  requireLocalCommerce()
  required(resource?.id)
  required(resource?.name)
  required(resource?.primaryAccountable?.id)
  required(passport?.ID)
  if (passport?.ProductID !== resource.id) throw new Error("passport_binding_mismatch")

  const subject = verifySignedOperation(auth, "commerce.listing.create", { resource, dpp: passport }, resource.primaryAccountable.id)
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  const products = container.resolve<IProductModuleService>(Modules.PRODUCT)
  const operationKey = sourceHash(["interfacer-local-v1", resource.id, "default"])
  const source = sourceHash(resource)
  const dpp = sourceHash(passport)

  return integration.withProjectionLock(operationKey, async () => {
    // Every retry was verified before entering the lock; no injectable allow decision.
    const identity = {
      operation_key: operationKey,
      catalog_resource_id: resource.id,
      source_dpp_id: passport.ID,
      seller_agent_id: subject,
      source_snapshot_hash: source,
      passport_snapshot_hash: dpp,
    }
    const assertSameSource = (row: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(identity)) {
        if (row[key] !== value) throw new Error("idempotency_conflict: immutable source changed")
      }
    }
    const [bound] = await integration.listListingBindings({ operation_key: operationKey })
    if (bound) {
      assertSameSource(bound)
      const product = await products.retrieveProduct(bound.medusa_product_id, { relations: ["variants"] })
      // Binding status is immutable creation evidence, not current publication state.
      if (!["draft", "published"].includes(product.status) || product.variants?.length !== 1 ||
          product.variants[0].id !== bound.medusa_variant_id ||
          product.metadata?.interfacer_resource_id !== bound.catalog_resource_id ||
          product.metadata?.interfacer_dpp_id !== bound.source_dpp_id) {
        throw new Error("reconciliation_required: bound commerce projection changed")
      }
      return { created: false, recovered: false, binding: bound, product }
    }

    let [intent] = await integration.listProjectionIntents({ operation_key: operationKey })
    if (intent) assertSameSource(intent)
    else intent = await integration.createProjectionIntents({
      ...identity,
      product_handle: "interfacer-" + operationKey,
    })

    const metadata = {
      interfacer_intent_id: intent.id,
      interfacer_resource_id: resource.id,
      interfacer_dpp_id: passport.ID,
    }
    let [product] = await products.listProducts({ handle: intent.product_handle }, { relations: ["variants"] })
    const recovered = Boolean(product)
    if (!product) {
      const { result } = await createProductsWorkflow(container).run({
        input: { products: [{
          title: resource.name,
          handle: intent.product_handle,
          status: ProductStatus.DRAFT,
          metadata,
          options: [{ title: "Configuration", values: ["Default"] }],
          variants: [{
            title: "Default",
            options: { Configuration: "Default" },
            manage_inventory: false,
            allow_backorder: false,
            prices: [],
          }],
        }] },
      })
      product = result[0] as ProductDTO
      afterProduct?.()
    }
    // Never create another product to hide a partial workflow or edited orphan.
    // A mid-workflow crash with no variant requires explicit operator repair.
    if (product.status !== "draft" || product.title !== resource.name ||
        product.variants?.length !== 1 ||
        Object.entries(metadata).some(([k,v]) => product.metadata?.[k] !== v)) {
      throw new Error("reconciliation_required: incomplete or conflicting projection")
    }
    const binding = await integration.createListingBindings({
      ...identity,
      medusa_product_id: product.id,
      medusa_variant_id: product.variants[0].id,
      configuration_key: "default",
      approved_revision: source,
      policy_version: "local-ed25519-envelope-v1",
      permission_epoch: "local-keyring-v1",
      status: "draft",
    })
    return { created: !recovered, recovered, binding, product }
  })
}
