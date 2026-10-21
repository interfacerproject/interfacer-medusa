import type { ExecArgs, IProductModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import type InterfacerService from "../modules/interfacer/service"
import { INTERFACER_MODULE } from "../modules/interfacer"
import { fixtures } from "./fixtures"

export default async function inspect({ container }: ExecArgs) {
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  const products = container.resolve<IProductModuleService>(Modules.PRODUCT)
  const { resource } = fixtures()
  const bindings = await integration.listListingBindings({ catalog_resource_id: resource.id })
  if (bindings.length !== 1) throw new Error("Expected one sample binding; project it first")
  const product = await products.retrieveProduct(bindings[0].medusa_product_id, { relations: ["variants"] })
  console.log(JSON.stringify({ product, binding: bindings[0] }, null, 2))
}
