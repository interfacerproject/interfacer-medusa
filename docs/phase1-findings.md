# P1 — verified commerce APIs (Medusa 2.10.3)

All paths below are under `medusa/node_modules/@medusajs/`. Exact package
pins remain unchanged. These APIs were inspected **and exercised** by
`npm run test:p1`, not inferred from a different Medusa version.

| Building block | Installed source / verified shape |
| --- | --- |
| Region | `core-flows/dist/region/workflows/create-regions.js`: `createRegionsWorkflow(container).run({input:{regions:[{name,currency_code:"eur",countries:["de"],automatic_taxes:false}]}})`. Workflow also creates region price preferences. |
| Sales channel | `core-flows/dist/sales-channel/workflows/create-sales-channels.*`: `createSalesChannelsWorkflow`, input `salesChannelsData`. |
| Stock location | `core-flows/dist/stock-location/workflows/create-stock-locations.*`: `createStockLocationsWorkflow`, input `locations`. |
| Location ↔ channel | `core-flows/dist/stock-location/workflows/link-sales-channels-to-stock-location.js`: `linkSalesChannelsToStockLocationWorkflow`, input `{id:location.id,add:[channel.id]}`. Link query alias is **sales_channel_location**, not sales_channel_stock_location (the latter is the table name). Verified definition: `link-modules/dist/definitions/sales-channel-location.js`. |
| Publishable API key | `core-flows/dist/api-key/workflows/create-api-keys.*`: `createApiKeysWorkflow`, input `api_keys:[{title,type:"publishable",created_by}]`; module `listApiKeys` returns `token`. No Admin secret created. |
| Key ↔ channel | `core-flows/dist/api-key/workflows/link-sales-channels-to-publishable-key.js`: exported function is **linkSalesChannelsToApiKeyWorkflow**, input `{id:key.id,add:[channel.id]}`. Query alias `publishable_api_key_sales_channel`, field `publishable_key_id`. |
| Store + EUR | `core-flows/dist/store/workflows/{create-stores,update-stores}.*`, `types/dist/store/mutations/store.d.ts`: `supported_currencies:[{currency_code:"eur",is_default:true}]`, default region/channel/location IDs. Existing default store reused. Medusa already knows EUR; no invented create-currency operation. |
| Price + publish + product ↔ channel | `core-flows/dist/product/workflows/update-products.js`: `updateProductsWorkflow(container).run({input:{products:[{id,status:ProductStatus.PUBLISHED,sales_channels:[{id}],variants:[{id,prices:[{id?,currency_code:"eur",amount:19.95}]}]}]}})`. Calls `upsertVariantPricesWorkflow` and native pricing/link steps, not direct SQL. |
| Price idempotency | `pricing/dist/services/pricing-module.js`, `updatePriceSets_`: incoming prices with IDs update; missing IDs create; omitted old IDs delete. Publisher queries existing price ID and preserves it. Same-price retry skips product workflow. Tested both unchanged retry and 19.95→20→19.95 with unchanged total row counts. |
| Browse | `medusa/dist/api/store/products/{route,middlewares,query-config}.js`: GET restricts published products and valid key-bound sales channels, sets pricing context from region, uses remote query. Explicit `fields=id,title,status,metadata,variants.id,variants.calculated_price.*` + `region_id` returns the EUR calculated price and only the projected DPP reference (not the passport). Without publishable header → 400; draft absent. |

Implementation:
- `medusa/src/modules/interfacer/commerce-context.ts`: named, locked, idempotent
  local seed. Queries links before creating them. Fail-closed for disabled
  channel, revoked key or changed region currency.
- `publish-listing.ts`: guarded merchant-only **local seed**, validates amount
  in major units; checks immutable binding against native product; serializes
  with the existing projection lock; preserves price and sales-channel links.
- `api/dev/interfacer/local-guard.ts`: extracted original CORS/fixture/production
  guard, shared by listings, seed and publish routes.
- Projection retry accepts a correctly bound published product. Immutable
  ListingBinding remains historical draft evidence; never updated.
- `scripts/p1-probe.py`: real curl and read-only SQL count assertions against
  all price/link rows. All writes are supported module/workflow operations.
- `scripts/server-lifecycle.py`: unique new server session, discovers only its
  process group members and signals **each PID**, not `os.killpg`. Both prior
  probes now use this cleanup too.

Verification (actual exit 0):
- `npm run seed:commerce` + `PRICE_EUR=19.95 npm run publish` against the
  original Phase 0 sample.
- `npm test`, `npm run test:http`, and repeated `npm run test:p1` on the
  existing default DB, including its now-published original sample.
- Cold P1 test on separately created `interfacer_medusa_p1_acceptance`, then
  retained. Full commands, keys and selected raw curl responses: [TESTING.md](../TESTING.md#p1--storefront--publish).

Limits: local fixture mode is not real signed/controller authorization. The
demo's default store currency configuration is intentionally replaced by EUR.
The automatically initialized default sales channel remains, alongside the
one named seed channel. No direct product→region link exists here; region is
pricing context. Location link alone is not inventory, shipping or fulfillment;
Phase 0's `manage_inventory:false` remains until P2. No checkout, tax calculation,
payment, browser automation, GUI build or live Interfacer/DPP write was claimed.
No ledger DONE line added: orchestration verification remains the orchestrator's.
