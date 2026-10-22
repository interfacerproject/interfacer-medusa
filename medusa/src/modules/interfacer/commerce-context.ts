// LOCAL DEMO ONLY. No production/customer price authority is provided here.
import type {
  MedusaContainer, IRegionModuleService, ISalesChannelModuleService,
  IStockLocationService, IApiKeyModuleService, IStoreModuleService,
} from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createRegionsWorkflow, createSalesChannelsWorkflow, createStockLocationsWorkflow,
  createApiKeysWorkflow, createStoresWorkflow, updateStoresWorkflow,
  linkSalesChannelsToApiKeyWorkflow, linkSalesChannelsToStockLocationWorkflow,
} from "@medusajs/medusa/core-flows"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"

export function requireLocalCommerce() {
  if (process.env.INTERFACER_AUTH_MODE !== "signed-envelope-local" ||
      process.env.NODE_ENV === "production") throw new Error("local_fixture_mode_required")
}

const NAME = "Interfacer local EUR"
const KEY_TITLE = "Interfacer local storefront"

export async function seedCommerce(container: MedusaContainer) {
  requireLocalCommerce()
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  return integration.withProjectionLock("interfacer-commerce-context-v1", async () => {
    const regions = container.resolve<IRegionModuleService>(Modules.REGION)
    const channels = container.resolve<ISalesChannelModuleService>(Modules.SALES_CHANNEL)
    const locations = container.resolve<IStockLocationService>(Modules.STOCK_LOCATION)
    const keys = container.resolve<IApiKeyModuleService>(Modules.API_KEY)
    const stores = container.resolve<IStoreModuleService>(Modules.STORE)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    let [region] = await regions.listRegions({ name: NAME })
    if (!region) {
      const { result } = await createRegionsWorkflow(container).run({ input: { regions: [{
        name: NAME, currency_code: "eur", countries: ["de"], automatic_taxes: false,
      }] } })
      region = result[0]
    }
    if (region.currency_code !== "eur") throw new Error("reconciliation_required: region currency changed")
    let [channel] = await channels.listSalesChannels({ name: NAME })
    if (!channel) {
      const { result } = await createSalesChannelsWorkflow(container).run({
        input: { salesChannelsData: [{ name: NAME, is_disabled: false }] },
      })
      channel = result[0]
    }
    if (channel.is_disabled) throw new Error("reconciliation_required: sales channel disabled")
    let [location] = await locations.listStockLocations({ name: NAME })
    if (!location) {
      const { result } = await createStockLocationsWorkflow(container).run({
        input: { locations: [{ name: NAME }] },
      })
      location = result[0]
    }
    let [key] = await keys.listApiKeys({ title: KEY_TITLE, type: "publishable" })
    if (!key) {
      const { result } = await createApiKeysWorkflow(container).run({ input: { api_keys: [{
        title: KEY_TITLE, type: "publishable", created_by: "interfacer-local-seed",
      }] } })
      key = result[0]
    }
    if (key.revoked_at) throw new Error("reconciliation_required: storefront key revoked")
    const { data: keyLinks } = await query.graph({
      entity: "publishable_api_key_sales_channel",
      fields: ["publishable_key_id", "sales_channel_id"],
      filters: { publishable_key_id: key.id, sales_channel_id: channel.id },
    })
    if (!keyLinks.length) await linkSalesChannelsToApiKeyWorkflow(container).run({
      input: { id: key.id, add: [channel.id] },
    })
    const { data: locationLinks } = await query.graph({
      entity: "sales_channel_location", fields: ["sales_channel_id", "stock_location_id"],
      filters: { stock_location_id: location.id, sales_channel_id: channel.id },
    })
    if (!locationLinks.length) await linkSalesChannelsToStockLocationWorkflow(container).run({
      input: { id: location.id, add: [channel.id] },
    })

    // Medusa normally initializes one store. Reuse it, rather than minting a second.
    let [store] = await stores.listStores()
    const defaults = {
      supported_currencies: [{ currency_code: "eur", is_default: true }],
      default_region_id: region.id, default_sales_channel_id: channel.id,
      default_location_id: location.id,
    }
    if (!store) {
      const { result } = await createStoresWorkflow(container).run({
        input: { stores: [{ name: NAME, ...defaults }] },
      })
      store = result[0]
    } else {
      await updateStoresWorkflow(container).run({ input: { selector: { id: store.id }, update: defaults } })
    }
    return {
      currency_code: "eur", store_id: store.id, region_id: region.id,
      sales_channel_id: channel.id, stock_location_id: location.id,
      publishable_key_id: key.id, publishable_key: key.token,
    }
  })
}
