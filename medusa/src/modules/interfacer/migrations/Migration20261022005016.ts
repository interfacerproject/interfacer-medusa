import { Migration } from "@mikro-orm/migrations"

export class Migration20261022005016 extends Migration {
  override async up(): Promise<void> {
    for (const table of ["interfacer_build_offer", "interfacer_build_acceptance"]) {
      this.addSql(`CREATE TRIGGER interfacer_immutable BEFORE UPDATE OR DELETE ON "${table}"
        FOR EACH ROW EXECUTE FUNCTION interfacer_reject_mutation();`)
    }
    this.addSql(`ALTER TABLE "interfacer_rea_receipt" ADD CONSTRAINT interfacer_production_references
      CHECK (action <> 'produce' OR (design_id IS NOT NULL AND service_id IS NOT NULL
        AND origin_dpp_id IS NOT NULL AND quote_id IS NOT NULL AND quote_hash IS NOT NULL
        AND quote_hash ~ '^[0-9a-f]{64}$' AND resource_id = design_id AND dpp_id = origin_dpp_id));`)
  }
  override async down(): Promise<void> {
    for (const table of ["interfacer_build_offer", "interfacer_build_acceptance"])
      this.addSql(`DROP TRIGGER IF EXISTS interfacer_immutable ON "${table}";`)
    this.addSql('ALTER TABLE "interfacer_rea_receipt" DROP CONSTRAINT IF EXISTS interfacer_production_references;')
  }
}
