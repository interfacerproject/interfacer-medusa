import { Migration } from "@mikro-orm/migrations"

// Release 4ku.1/4ku.2: sellers' Stripe Connect accounts and signed commission
// terms, per-order payouts, after-sale cases (cancellation, return) and refunds.
export class Migration20261126120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "interfacer_seller_account" ("id" text not null, "person_id" text not null, "stripe_account_id" text not null, "country" text not null, "terms_version" text not null, "fee_bps" integer not null, "fee_fixed_cents" integer not null, "terms_accepted_at" timestamptz not null, "details_submitted" boolean not null default false, "payouts_enabled" boolean not null default false, "transfers_active" boolean not null default false, "status_checked_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_seller_account_pkey" primary key ("id"), constraint "interfacer_seller_account_fee" check ("fee_bps" between 0 and 5000 and "fee_fixed_cents" >= 0));`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_seller_account_person_id_unique" ON "interfacer_seller_account" (person_id) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_seller_account_stripe_account_id_unique" ON "interfacer_seller_account" (stripe_account_id) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_seller_account_deleted_at" ON "interfacer_seller_account" (deleted_at) WHERE deleted_at IS NULL;`)

    this.addSql(`create table if not exists "interfacer_payout" ("id" text not null, "order_id" text not null, "seller_person_id" text not null, "stripe_account_id" text not null, "payment_intent_id" text not null, "charge_id" text null, "currency_code" text not null, "gross_cents" integer not null, "fee_cents" integer not null, "net_cents" integer not null, "terms_version" text not null, "status" text check ("status" in ('held', 'transferred', 'canceled', 'blocked')) not null default 'held', "release_at" timestamptz not null, "transfer_id" text null, "transferred_cents" integer not null default 0, "reversed_cents" integer not null default 0, "attempts" integer not null default 0, "next_attempt_at" timestamptz not null, "last_error" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_payout_pkey" primary key ("id"), constraint "interfacer_payout_amounts" check ("gross_cents" >= 0 and "fee_cents" >= 0 and "net_cents" >= 0 and "fee_cents" + "net_cents" = "gross_cents" and "transferred_cents" between 0 and "net_cents" and "reversed_cents" between 0 and "transferred_cents"));`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_payout_order_id_unique" ON "interfacer_payout" (order_id) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_payout_seller" ON "interfacer_payout" (seller_person_id) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_payout_due" ON "interfacer_payout" (status, next_attempt_at) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_payout_deleted_at" ON "interfacer_payout" (deleted_at) WHERE deleted_at IS NULL;`)

    this.addSql(`create table if not exists "interfacer_aftersale_case" ("id" text not null, "order_id" text not null, "kind" text check ("kind" in ('cancellation', 'return')) not null, "status" text check ("status" in ('requested', 'accepted', 'rejected', 'withdrawn', 'returned', 'refunded')) not null default 'requested', "buyer_person_id" text not null, "seller_person_id" text not null, "reason" text not null, "seller_note" text null, "responded_at" timestamptz null, "returned_at" timestamptz null, "closed_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_aftersale_case_pkey" primary key ("id"), constraint "interfacer_aftersale_case_reason" check (length("reason") between 1 and 2000));`)
    // At most one open case per order: a second request waits for the first.
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_aftersale_case_one_open" ON "interfacer_aftersale_case" (order_id) WHERE deleted_at IS NULL AND status IN ('requested', 'accepted', 'returned');`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_aftersale_case_order_id" ON "interfacer_aftersale_case" (order_id) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_aftersale_case_deleted_at" ON "interfacer_aftersale_case" (deleted_at) WHERE deleted_at IS NULL;`)

    this.addSql(`create table if not exists "interfacer_refund" ("id" text not null, "order_id" text not null, "case_id" text null, "amount_cents" integer not null, "reason" text not null, "requested_by" text not null, "status" text check ("status" in ('pending', 'done', 'failed')) not null default 'pending', "reversal_cents" integer not null default 0, "reversal_id" text null, "last_error" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_refund_pkey" primary key ("id"), constraint "interfacer_refund_amount" check ("amount_cents" > 0 and "reversal_cents" >= 0));`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_refund_order_id" ON "interfacer_refund" (order_id) WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_refund_deleted_at" ON "interfacer_refund" (deleted_at) WHERE deleted_at IS NULL;`)
  }
  override async down(): Promise<void> {
    this.addSql(`drop table if exists "interfacer_refund" cascade;`)
    this.addSql(`drop table if exists "interfacer_aftersale_case" cascade;`)
    this.addSql(`drop table if exists "interfacer_payout" cascade;`)
    this.addSql(`drop table if exists "interfacer_seller_account" cascade;`)
  }
}
