import { Migration } from "@mikro-orm/migrations"

// One-use signed envelopes: a (person, nonce) pair is accepted once. Rows only
// need to outlive the ±5-minute issued_at window, so old ones are purged.
export class Migration20261110090000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "interfacer_envelope_nonce" ("person_id" text not null, "nonce" text not null, "op" text not null, "issued_at" timestamptz not null, "created_at" timestamptz not null default now(), constraint "interfacer_envelope_nonce_pkey" primary key ("person_id", "nonce"), constraint "interfacer_envelope_nonce_format" check ("nonce" ~ '^[0-9a-f]{32}$'));`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_envelope_nonce_issued_at" ON "interfacer_envelope_nonce" (issued_at);`)
  }
  override async down(): Promise<void> {
    this.addSql(`drop table if exists "interfacer_envelope_nonce" cascade;`)
  }
}
