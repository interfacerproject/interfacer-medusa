import { Migration } from "@mikro-orm/migrations"

// Build listings: immutable signed revisions per (service, design).
export class Migration20261109120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "interfacer_build_listing" ("id" text not null, "service_resource_id" text not null, "design_resource_id" text not null, "revision" integer not null, "entry_key" text not null, "owner_agent_id" text not null, "active" boolean not null, "base_price_cents" integer not null, "per_unit_price_cents" integer not null, "lead_days" integer not null, "terms_hash" text not null, "registered_by" text not null, "registration_hash" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_build_listing_pkey" primary key ("id"), constraint "interfacer_build_listing_revision_positive" check ("revision" > 0), constraint "interfacer_build_listing_owner_signed" check ("owner_agent_id" = "registered_by"), constraint "interfacer_build_listing_prices" check ("base_price_cents" >= 0 and "per_unit_price_cents" >= 0 and "base_price_cents" + "per_unit_price_cents" > 0), constraint "interfacer_build_listing_lead_days" check ("lead_days" between 1 and 365));`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_build_listing_entry_key_unique" ON "interfacer_build_listing" (entry_key) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_build_listing_revision" ON "interfacer_build_listing" (service_resource_id, design_resource_id, revision) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_build_listing_deleted_at" ON "interfacer_build_listing" (deleted_at) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE TRIGGER interfacer_immutable BEFORE UPDATE OR DELETE ON "interfacer_build_listing"
      FOR EACH ROW EXECUTE FUNCTION interfacer_reject_mutation();`)
  }
  override async down(): Promise<void> {
    this.addSql(`drop table if exists "interfacer_build_listing" cascade;`)
  }
}
