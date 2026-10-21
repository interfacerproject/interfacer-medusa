import { MedusaService } from "@medusajs/framework/utils"
import { Client } from "pg"
import { ListingBinding, ProjectionIntent } from "./models/listing-binding"

export default class InterfacerService extends MedusaService({ ListingBinding, ProjectionIntent }) {
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
}
