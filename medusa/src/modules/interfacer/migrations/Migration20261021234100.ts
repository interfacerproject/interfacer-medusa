import { Migration } from "@mikro-orm/migrations"

export class Migration20261021234100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TRIGGER interfacer_immutable BEFORE UPDATE OR DELETE ON "interfacer_identity_link"
      FOR EACH ROW EXECUTE FUNCTION interfacer_reject_mutation();`)
  }
  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS interfacer_immutable ON "interfacer_identity_link";')
  }
}
