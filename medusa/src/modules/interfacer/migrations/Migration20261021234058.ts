import { Migration } from '@mikro-orm/migrations';

export class Migration20261021234058 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "interfacer_identity_link" drop constraint if exists "interfacer_identity_link_person_id_unique";`);
    this.addSql(`alter table if exists "interfacer_identity_link" drop constraint if exists "interfacer_identity_link_customer_id_unique";`);
    this.addSql(`create table if not exists "interfacer_identity_link" ("id" text not null, "customer_id" text not null, "person_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "interfacer_identity_link_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_identity_link_customer_id_unique" ON "interfacer_identity_link" (customer_id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_interfacer_identity_link_person_id_unique" ON "interfacer_identity_link" (person_id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_interfacer_identity_link_deleted_at" ON "interfacer_identity_link" (deleted_at) WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "interfacer_identity_link" cascade;`);
  }

}
