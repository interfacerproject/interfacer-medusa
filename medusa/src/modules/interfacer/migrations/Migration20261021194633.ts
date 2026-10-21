import { Migration } from '@mikro-orm/migrations';

export class Migration20261021194633 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "interfacer_projection_intent" drop constraint if exists "interfacer_projection_intent_product_handle_unique";`);
    this.addSql(`alter table if exists "interfacer_projection_intent" drop constraint if exists "interfacer_projection_intent_catalog_resource_id_unique";`);
    this.addSql(`alter table if exists "interfacer_projection_intent" drop constraint if exists "interfacer_projection_intent_operation_key_unique";`);
    this.addSql(`alter table if exists "interfacer_listing_binding" drop constraint if exists "interfacer_listing_binding_medusa_variant_id_unique";`);
    this.addSql(`alter table if exists "interfacer_listing_binding" drop constraint if exists "interfacer_listing_binding_medusa_product_id_unique";`);
    this.addSql(`alter table if exists "interfacer_listing_binding" drop constraint if exists "interfacer_listing_binding_catalog_resource_id_unique";`);
    this.addSql(`alter table if exists "interfacer_listing_binding" drop constraint if exists "interfacer_listing_binding_operation_key_unique";`);
    this.addSql(`create table if not exists "interfacer_listing_binding" ("id" text not null, "operation_key" text not null, "catalog_resource_id" text not null, "source_dpp_id" text not null, "seller_agent_id" text not null, "medusa_product_id" text not null, "medusa_variant_id" text not null, "configuration_key" text not null, "source_snapshot_hash" text not null, "passport_snapshot_hash" text not null, "approved_revision" text not null, "policy_version" text not null, "permission_epoch" text not null, "status" text check ("status" in ('draft')) not null default 'draft', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_listing_binding_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_listing_binding_operation_key_unique" ON "interfacer_listing_binding" (operation_key) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_listing_binding_catalog_resource_id_unique" ON "interfacer_listing_binding" (catalog_resource_id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_listing_binding_medusa_product_id_unique" ON "interfacer_listing_binding" (medusa_product_id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_listing_binding_medusa_variant_id_unique" ON "interfacer_listing_binding" (medusa_variant_id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_listing_binding_deleted_at" ON "interfacer_listing_binding" (deleted_at) WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "interfacer_projection_intent" ("id" text not null, "operation_key" text not null, "catalog_resource_id" text not null, "source_dpp_id" text not null, "seller_agent_id" text not null, "source_snapshot_hash" text not null, "passport_snapshot_hash" text not null, "product_handle" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_projection_intent_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_projection_intent_operation_key_unique" ON "interfacer_projection_intent" (operation_key) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_projection_intent_catalog_resource_id_unique" ON "interfacer_projection_intent" (catalog_resource_id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_projection_intent_product_handle_unique" ON "interfacer_projection_intent" (product_handle) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_projection_intent_deleted_at" ON "interfacer_projection_intent" (deleted_at) WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "interfacer_listing_binding" cascade;`);

    this.addSql(`drop table if exists "interfacer_projection_intent" cascade;`);
  }

}
