import { Migration } from "@mikro-orm/migrations"

// Bridge C: record the live Zenflows EconomicEvent id on the receipt.
export class Migration20261022120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "interfacer_rea_receipt" add column if not exists "zenflows_event_id" text null;`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "interfacer_rea_receipt" drop column if exists "zenflows_event_id";`,
    )
  }
}
