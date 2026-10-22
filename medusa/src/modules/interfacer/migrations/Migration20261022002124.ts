import { Migration } from '@mikro-orm/migrations';

export class Migration20261022002124 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "interfacer_rea_receipt" drop constraint if exists "interfacer_rea_receipt_order_id_unique";`);
    this.addSql(`create table if not exists "interfacer_rea_receipt" ("id" text not null, "action" text check ("action" in ('transfer')) not null, "provider_id" text not null, "receiver_id" text not null, "resource_id" text not null, "dpp_id" text not null, "order_id" text not null, "quantity" integer not null, "has_point_in_time" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_rea_receipt_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_rea_receipt_order_id_unique" ON "interfacer_rea_receipt" (order_id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_rea_receipt_deleted_at" ON "interfacer_rea_receipt" (deleted_at) WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "interfacer_rea_receipt" cascade;`);
  }

}
