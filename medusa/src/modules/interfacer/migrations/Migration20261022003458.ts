import { Migration } from "@mikro-orm/migrations"

export class Migration20261022003458 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TRIGGER interfacer_immutable BEFORE UPDATE OR DELETE ON "interfacer_build_quote"
      FOR EACH ROW EXECUTE FUNCTION interfacer_reject_mutation();`)
    this.addSql(`ALTER TABLE "interfacer_build_quote" ADD CONSTRAINT interfacer_quote_valid_terms
      CHECK (quantity > 0 AND total_price_cents > 0 AND quote_hash ~ '^[0-9a-f]{64}$');`)
    this.addSql(`ALTER TABLE "interfacer_service" ADD CONSTRAINT interfacer_service_nonnegative_price
      CHECK (base_price_cents >= 0 AND per_unit_price_cents >= 0);`)
  }
  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS interfacer_immutable ON "interfacer_build_quote";')
    this.addSql('ALTER TABLE "interfacer_build_quote" DROP CONSTRAINT IF EXISTS interfacer_quote_valid_terms;')
    this.addSql('ALTER TABLE "interfacer_service" DROP CONSTRAINT IF EXISTS interfacer_service_nonnegative_price;')
  }
}
