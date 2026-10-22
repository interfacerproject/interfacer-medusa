import { Migration } from "@mikro-orm/migrations"

export class Migration20261022002125 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TRIGGER interfacer_immutable BEFORE UPDATE OR DELETE ON "interfacer_rea_receipt"
      FOR EACH ROW EXECUTE FUNCTION interfacer_reject_mutation();`)
    this.addSql(`ALTER TABLE "interfacer_rea_receipt" ADD CONSTRAINT interfacer_receipt_positive_quantity CHECK (quantity > 0);`)
  }
  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS interfacer_immutable ON "interfacer_rea_receipt";')
    this.addSql('ALTER TABLE "interfacer_rea_receipt" DROP CONSTRAINT IF EXISTS interfacer_receipt_positive_quantity;')
  }
}
