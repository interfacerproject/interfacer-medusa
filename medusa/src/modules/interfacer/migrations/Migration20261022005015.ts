import { Migration } from '@mikro-orm/migrations';

export class Migration20261022005015 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "interfacer_build_offer" drop constraint if exists "interfacer_build_offer_medusa_variant_id_unique";`);
    this.addSql(`alter table if exists "interfacer_build_offer" drop constraint if exists "interfacer_build_offer_medusa_product_id_unique";`);
    this.addSql(`alter table if exists "interfacer_build_offer" drop constraint if exists "interfacer_build_offer_quote_id_unique";`);
    this.addSql(`alter table if exists "interfacer_build_acceptance" drop constraint if exists "interfacer_build_acceptance_cart_id_unique";`);
    this.addSql(`create table if not exists "interfacer_build_acceptance" ("id" text not null, "cart_id" text not null, "customer_id" text not null, "quote_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_build_acceptance_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_build_acceptance_cart_id_unique" ON "interfacer_build_acceptance" (cart_id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_build_acceptance_deleted_at" ON "interfacer_build_acceptance" (deleted_at) WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "interfacer_build_offer" ("id" text not null, "quote_id" text not null, "medusa_product_id" text not null, "medusa_variant_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_build_offer_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_build_offer_quote_id_unique" ON "interfacer_build_offer" (quote_id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_build_offer_medusa_product_id_unique" ON "interfacer_build_offer" (medusa_product_id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_build_offer_medusa_variant_id_unique" ON "interfacer_build_offer" (medusa_variant_id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_build_offer_deleted_at" ON "interfacer_build_offer" (deleted_at) WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "interfacer_rea_receipt" drop constraint if exists "interfacer_rea_receipt_action_check";`);

    this.addSql(`alter table if exists "interfacer_rea_receipt" add column if not exists "design_id" text null, add column if not exists "service_id" text null, add column if not exists "origin_dpp_id" text null, add column if not exists "quote_id" text null, add column if not exists "quote_hash" text null;`);
    this.addSql(`alter table if exists "interfacer_rea_receipt" add constraint "interfacer_rea_receipt_action_check" check("action" in ('transfer', 'produce'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "interfacer_build_acceptance" cascade;`);

    this.addSql(`drop table if exists "interfacer_build_offer" cascade;`);

    this.addSql(`alter table if exists "interfacer_rea_receipt" drop constraint if exists "interfacer_rea_receipt_action_check";`);

    this.addSql(`alter table if exists "interfacer_rea_receipt" drop column if exists "design_id", drop column if exists "service_id", drop column if exists "origin_dpp_id", drop column if exists "quote_id", drop column if exists "quote_hash";`);

    this.addSql(`alter table if exists "interfacer_rea_receipt" add constraint "interfacer_rea_receipt_action_check" check("action" in ('transfer'));`);
  }

}
