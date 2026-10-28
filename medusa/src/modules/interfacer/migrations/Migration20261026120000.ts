import { Migration } from "@mikro-orm/migrations"

// P1 outbox: one durable Zenflows sync row per live milestone receipt.
export class Migration20261026120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "interfacer_zenflows_sync" ("id" text not null, "order_id" text not null, "receipt_id" text not null, "marker" text not null, "payload" jsonb not null, "payload_hash" text not null, "status" text check ("status" in ('pending', 'done', 'blocked')) not null default 'pending', "process_id" text null, "resource_id" text null, "creation_event_id" text null, "transfer_event_id" text null, "inflight_step" text check ("inflight_step" in ('process', 'create', 'transfer')) null, "inflight_at" timestamptz null, "attempts" integer not null default 0, "next_attempt_at" timestamptz not null, "last_error" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_zenflows_sync_pkey" primary key ("id"));`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_zenflows_sync_order_id_unique" ON "interfacer_zenflows_sync" (order_id) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_zenflows_sync_receipt_id_unique" ON "interfacer_zenflows_sync" (receipt_id) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_zenflows_sync_marker_unique" ON "interfacer_zenflows_sync" (marker) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_zenflows_sync_due" ON "interfacer_zenflows_sync" (status, next_attempt_at) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_zenflows_sync_deleted_at" ON "interfacer_zenflows_sync" (deleted_at) WHERE deleted_at IS NULL;`)
  }
  override async down(): Promise<void> {
    this.addSql(`drop table if exists "interfacer_zenflows_sync" cascade;`)
  }
}
