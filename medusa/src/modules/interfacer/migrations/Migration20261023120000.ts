import { Migration } from "@mikro-orm/migrations"

export class Migration20261023120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table "interfacer_identity_link" add column if not exists "zenflows_person_id" text null;')
  }
  override async down(): Promise<void> {
    this.addSql('alter table "interfacer_identity_link" drop column if exists "zenflows_person_id";')
  }
}
