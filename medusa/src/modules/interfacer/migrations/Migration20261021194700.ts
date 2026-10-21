import { Migration } from "@mikro-orm/migrations"

export class Migration20261021194700 extends Migration {
  override async up(): Promise<void> {
    // No API, generated service method, soft-delete, or commerce administrator
    // may silently rebind these rows. DB-owner DDL remains an operator privilege.
    this.addSql(`CREATE FUNCTION interfacer_reject_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'interfacer_immutable: create a new reviewed mapping';
      END; $$;`)
    for (const table of ["interfacer_listing_binding", "interfacer_projection_intent"]) {
      this.addSql(`CREATE TRIGGER interfacer_immutable BEFORE UPDATE OR DELETE ON "${table}"
        FOR EACH ROW EXECUTE FUNCTION interfacer_reject_mutation();`)
    }
  }

  override async down(): Promise<void> {
    for (const table of ["interfacer_listing_binding", "interfacer_projection_intent"]) {
      this.addSql(`DROP TRIGGER IF EXISTS interfacer_immutable ON "${table}";`)
    }
    this.addSql("DROP FUNCTION IF EXISTS interfacer_reject_mutation();")
  }
}
