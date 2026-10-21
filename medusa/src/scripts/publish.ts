import type { ExecArgs } from "@medusajs/framework/types"
import type InterfacerService from "../modules/interfacer/service"
import { INTERFACER_MODULE } from "../modules/interfacer"
import { publishListing } from "../modules/interfacer/publish-listing"
import { fixtures } from "./fixtures"

export default async function publish({ container }: ExecArgs) {
  let id = process.env.LISTING_ID
  if (!id) {
    const service = container.resolve<InterfacerService>(INTERFACER_MODULE)
    const [binding] = await service.listListingBindings({ catalog_resource_id: fixtures().resource.id })
    id = binding?.id
  }
  if (!id) throw new Error("Project the resource first, or provide LISTING_ID (binding id)")
  console.log(JSON.stringify(await publishListing(container, id, Number(process.env.PRICE_EUR)), null, 2))
}
