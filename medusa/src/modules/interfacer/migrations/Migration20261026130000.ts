import { Migration } from "@mikro-orm/migrations"

// P2 live catalog (immutable revisions) + the live listing's resource unit.
export class Migration20261026130000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "interfacer_catalog_entry" ("id" text not null, "kind" text check ("kind" in ('design', 'service')) not null, "zenflows_resource_id" text not null, "revision" integer not null, "entry_key" text not null, "owner_agent_id" text not null, "resource_name" text not null, "spec_id" text not null, "schema_version" text not null, "document" jsonb not null, "document_hash" text not null, "registered_by" text not null, "registration_hash" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_catalog_entry_pkey" primary key ("id"), constraint "interfacer_catalog_entry_revision_positive" check ("revision" > 0), constraint "interfacer_catalog_entry_owner_signed" check ("owner_agent_id" = "registered_by"));`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_catalog_entry_entry_key_unique" ON "interfacer_catalog_entry" (entry_key) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_catalog_entry_revision" ON "interfacer_catalog_entry" (kind, zenflows_resource_id, revision) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_catalog_entry_deleted_at" ON "interfacer_catalog_entry" (deleted_at) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE TRIGGER interfacer_immutable BEFORE UPDATE OR DELETE ON "interfacer_catalog_entry"
      FOR EACH ROW EXECUTE FUNCTION interfacer_reject_mutation();`)
    this.addSql(`alter table if exists "interfacer_listing_binding" add column if not exists "zenflows_unit_id" text null;`)
  }
  override async down(): Promise<void> {
    this.addSql(`drop table if exists "interfacer_catalog_entry" cascade;`)
    this.addSql(`alter table if exists "interfacer_listing_binding" drop column if exists "zenflows_unit_id";`)
  }
}
