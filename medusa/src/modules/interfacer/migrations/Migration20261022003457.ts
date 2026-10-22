import { Migration } from '@mikro-orm/migrations';

export class Migration20261022003457 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "interfacer_build_quote" drop constraint if exists "interfacer_build_quote_quote_hash_unique";`);
    this.addSql(`create table if not exists "interfacer_build_quote" ("id" text not null, "design_id" text not null, "service_id" text not null, "provider_person_id" text not null, "origin_dpp_id" text null, "currency_code" text check ("currency_code" in ('eur')) not null, "quantity" integer not null, "total_price_cents" integer not null, "quote_hash" text not null, "snapshot" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_build_quote_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_build_quote_quote_hash_unique" ON "interfacer_build_quote" (quote_hash) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_build_quote_deleted_at" ON "interfacer_build_quote" (deleted_at) WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "interfacer_design" ("id" text not null, "name" text not null, "origin_dpp_id" text null, "requirements" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_design_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_design_deleted_at" ON "interfacer_design" (deleted_at) WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "interfacer_service" ("id" text not null, "name" text not null, "provider_person_id" text not null, "capabilities" jsonb not null, "base_price_cents" integer not null, "per_unit_price_cents" integer not null, "location" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_service_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_service_deleted_at" ON "interfacer_service" (deleted_at) WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "interfacer_build_quote" cascade;`);

    this.addSql(`drop table if exists "interfacer_design" cascade;`);

    this.addSql(`drop table if exists "interfacer_service" cascade;`);
  }

}
