import { InjectTransactionManager, MedusaContext, MedusaService } from "@medusajs/framework/utils"
import type { Context } from "@medusajs/framework/types"
import { Client } from "pg"
import { ListingBinding, ProjectionIntent } from "./models/listing-binding"
import { IdentityLink } from "./models/identity-link"
import { ReaReceipt } from "./models/rea-receipt"
import { Design } from "./models/design"
import { Service } from "./models/fabrication-service"
import { BuildQuote } from "./models/build-quote"
import { BuildOffer, BuildAcceptance } from "./models/build-offer"
import { ZenflowsSync } from "./models/zenflows-sync"
import { CatalogEntry } from "./models/catalog-entry"
import { BuildListing } from "./models/build-listing"

export default class InterfacerService extends MedusaService({ ListingBinding, ProjectionIntent, IdentityLink, ReaReceipt, Design, Service, BuildQuote, BuildOffer, BuildAcceptance, ZenflowsSync, CatalogEntry, BuildListing }) {
  // Session-scoped lock spans independent Medusa workflow transactions.
  // Only advisory locking here: never SQL-write a Medusa commerce table.
  async withProjectionLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    try {
      await client.query("SET lock_timeout = '30s'")
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key])
      return await work()
    } finally {
      // Closing the connection releases its lock, including on errors.
      await client.end()
    }
  }

  // Receipt and its outbox row commit together, before any remote write: a failed
  // insert can never leave Zenflows objects without a local record to reconcile.
  @InjectTransactionManager()
  async createReceiptWithSync(
    receipt: Parameters<InterfacerService["createReaReceipts"]>[0],
    sync: Record<string, unknown> | null,
    @MedusaContext() sharedContext: Context = {},
  ) {
    const created = await this.createReaReceipts(receipt as any, sharedContext) as any
    const row = sync ? await this.createZenflowsSyncs({ ...sync, receipt_id: created.id } as any, sharedContext) : null
    return { receipt: created, sync: row }
  }
}
