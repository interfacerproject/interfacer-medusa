import assert from "node:assert/strict"
import { test } from "node:test"
import { designs, services } from "../modules/interfacer/matching-fixtures"
import { fixedPrice, formBuildQuote, matchServices, parseDesign, parseService,
  rejectionReasons, termsHash } from "../modules/interfacer/matching"

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const d = designs[0], s = services[0]

test("every required process and material is covered, exact case-sensitive identifiers", () => {
  const design = clone(d)
  design.requirements.process.push("laser_cut")
  assert.match(rejectionReasons(design, s).join(), /wrong_process: missing laser_cut/)
  design.requirements.process = ["fdm_3d_print"]
  design.requirements.materials.push("ABS")
  assert.match(rejectionReasons(design, s).join(), /missing_material: ABS/)
  design.requirements.materials = ["petg"]
  assert.match(rejectionReasons(design, s).join(), /missing_material: petg/)
})
test("each axis fits without assuming rotation; equality fits", () => {
  for (const axis of ["x", "y", "z"] as const) {
    const design = clone(d)
    design.requirements.max_dimensions_mm[axis] = s.capabilities.build_volume_mm[axis]
    assert.deepEqual(rejectionReasons(design, s), [])
    design.requirements.max_dimensions_mm[axis] += 1
    assert.match(rejectionReasons(design, s).join(), new RegExp("too_big: " + axis))
  }
})
test("service minimum tolerance <= design tolerance, equality fits", () => {
  const design = clone(d)
  design.requirements.tolerance_mm = s.capabilities.min_tolerance_mm
  assert.deepEqual(rejectionReasons(design, s), [])
  design.requirements.tolerance_mm -= 0.01
  assert.match(rejectionReasons(design, s).join(), /tolerance:/)
})
test("rank by total EUR price, ties by ID; input order cannot affect output", () => {
  const tied = { ...s, id: "ifsvc_p4_aaa" }
  const input = [services[1], s, tied]
  const expected = ["ifsvc_p4_aaa", s.id, services[1].id]
  assert.deepEqual(matchServices(d, input).matches.map(v => v.id), expected)
  assert.deepEqual(matchServices(d, [...input].reverse()), matchServices(d, input))
})
test("synthetic fixtures give matches and concrete rejections for both designs", () => {
  const first = matchServices(d, services)
  assert.deepEqual(first.matches.map(v => v.id), ["ifsvc_p4_standard", "ifsvc_p4_large"])
  for (const reason of ["wrong_process", "missing_material", "too_big", "tolerance"]) {
    assert(first.rejected.some(r => r.reason.includes(reason)))
  }
  assert.deepEqual(matchServices(designs[1], services).matches.map(v => v.id), ["ifsvc_p4_large"])
})
test("base + unit × quantity computed in integer cents (not floating point EUR)", () => {
  assert.deepEqual(fixedPrice(d, s), { currency_code: "eur", quantity: 2,
    base_price_cents: 1000, per_unit_price_cents: 450, total_price_cents: 1900, amount_eur: 19 })
  assert.equal(fixedPrice(d, { ...s, base_price_eur: 0.1, per_unit_price_eur: 0.2 }).total_price_cents, 50)
  for (const price of [-1, NaN, Infinity, "10", 0.001, 1000001]) {
    assert.throws(() => parseService({ ...s, base_price_eur: price }), /invalid_price/)
  }
  assert.throws(() => fixedPrice(d, { ...s, base_price_eur: 0, per_unit_price_eur: 0 }), /invalid_quote_total/)
  assert.throws(() => fixedPrice(d, { ...s, base_price_eur: 1000000, per_unit_price_eur: 1 }), /invalid_quote_total/)
})
test("fail closed for missing, malformed, unsupported constraints and quantities", () => {
  for (const requirements of [
    { ...d.requirements, tags: ["PETG"] },
    { ...d.requirements, process: [] },
    { ...d.requirements, materials: ["PETG", "PETG"] },
    { ...d.requirements, max_dimensions_mm: { x: 1, y: 2 } },
    { ...d.requirements, max_dimensions_mm: { x: -1, y: 2, z: 3 } },
    { ...d.requirements, tolerance_mm: NaN },
    ...[0, -1, 1.5, "2", 1000001].map(quantity => ({ ...d.requirements, quantity })),
  ]) {
    assert.throws(() => matchServices({ ...d, requirements } as typeof d, services), /invalid_structured_data/)
  }
  assert.throws(() => parseDesign({ ...d, requirements: { tags: ["fdm_3d_print"] } }), /invalid_structured_data/)
  assert.throws(() => matchServices(d, [{ ...s, capabilities: {} } as typeof s]), /invalid_structured_data/)
})
test("incompatible pair cannot form a build quote", () => {
  assert.throws(() => formBuildQuote(d, services[2]), /incompatible_service: wrong_process/)
})
test("immutable detached snapshot, stable canonical hash, all terms bound", () => {
  const design = clone(d), service = clone(s), quote = formBuildQuote(design, service)
  assert.equal(quote.quote_hash, termsHash(quote.snapshot))
  assert.throws(() => { quote.total_price_cents = 1 }, TypeError)
  assert.equal(termsHash({ z: 1, a: 2 }), termsHash({ a: 2, z: 1 }))
  assert.throws(() => { quote.snapshot.service.base_price_eur = 1 }, TypeError)
  assert.throws(() => { quote.snapshot.design.requirements.materials.push("ABS") }, TypeError)
  service.base_price_eur = 999
  design.requirements.quantity = 4
  assert.equal(quote.snapshot.total_price_cents, 1900)
  for (const change of [
    formBuildQuote(d, { ...s, base_price_eur: 11 }),
    formBuildQuote(d, { ...s, provider_person_id: "different" }),
    formBuildQuote({ ...d, origin_dpp_id: "other-origin" }, s),
    formBuildQuote({ ...d, requirements: { ...d.requirements, quantity: 3 } }, s),
  ]) assert.notEqual(change.quote_hash, quote.quote_hash)
})
