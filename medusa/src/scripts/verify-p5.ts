import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import type { ExecArgs, ICartModuleService, IPaymentModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { capturePaymentWorkflow, completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { INTERFACER_MODULE } from "../modules/interfacer"
import type InterfacerService from "../modules/interfacer/service"
import { checkoutEvidence } from "../modules/interfacer/checkout-guard"
import { acceptBuild } from "../modules/interfacer/build-purchase"
import { produceBuild } from "../modules/interfacer/production"

export default async function verify({ container, args }: ExecArgs) {
  const state = JSON.parse(await readFile("../.tmp/p5-state.json", "utf8"))
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  if (args[0] === "capture") {
    for (const order of [state.order, state.payment_only]) {
      assert.equal((await integration.listReaReceipts({ order_id: order.id })).length, 0)
      const paymentId = order.payment_collections[0].payments[0].id
      await capturePaymentWorkflow(container).run({ input: { payment_id: paymentId } })
      const payment = await container.resolve<IPaymentModuleService>(Modules.PAYMENT).retrievePayment(paymentId)
      assert.ok(payment.captured_at)
      assert.equal((await integration.listReaReceipts({ order_id: order.id })).length, 0)
      console.log(`PASS NO EVENT ON CAPTURE: order=${order.id}, payment=${payment.id}, captured_at=${new Date(payment.captured_at).toISOString()}; zero production events.`)
    }
    return
  }
  const [receipt] = await integration.listReaReceipts({ order_id: state.order.id })
  assert.ok(receipt)
  await assert.rejects(() => integration.createReaReceipts({
    action: "produce", provider_id: receipt.provider_id, receiver_id: receipt.receiver_id,
    resource_id: receipt.resource_id, dpp_id: receipt.dpp_id, order_id: receipt.order_id,
    design_id: receipt.design_id, service_id: receipt.service_id, origin_dpp_id: receipt.origin_dpp_id,
    quote_id: receipt.quote_id, quote_hash: receipt.quote_hash,
    quantity: receipt.quantity, has_point_in_time: receipt.has_point_in_time,
  }), /unique|duplicate|already exists/i)
  await assert.rejects(() => integration.updateReaReceipts({ id: receipt.id, service_id: "forged" }), /interfacer_immutable/)
  await assert.rejects(() => integration.deleteReaReceipts([receipt.id]), /interfacer_immutable/)
  await assert.rejects(() => integration.softDeleteReaReceipts([receipt.id]), /interfacer_immutable/)
  await assert.rejects(() => integration.updateBuildOffers({ id: state.accepted.offer.id, quote_id: "forged" }), /interfacer_immutable/)
  await assert.rejects(() => integration.softDeleteBuildOffers([state.accepted.offer.id]), /interfacer_immutable/)
  await assert.rejects(() => integration.updateBuildAcceptances({ id: state.accepted.acceptance.id, quote_id: "forged" }), /interfacer_immutable/)
  await assert.rejects(() => integration.deleteBuildAcceptances([state.accepted.acceptance.id]), /interfacer_immutable/)
  await assert.rejects(() => acceptBuild(container, "unknown", "unknown", "unknown"), /local_fixture_mode_required/)
  await assert.rejects(() => produceBuild(container, state.order.id), /local_fixture_mode_required/)
  // Real always-on native workflow hook, without HTTP preparation or fixture mode.
  const { errors } = await completeCartWorkflow(container).run({ input: { id: state.direct_cart }, throwOnError: false })
  assert.match(errors[0]?.error.message, /interfacer_checkout_evidence_required/)
  const carts = container.resolve<ICartModuleService>(Modules.CART)
  const cart = await carts.retrieveCart(state.direct_cart, { relations: ["items"] })
  assert.equal(cart.completed_at, null)
  const evidence = await checkoutEvidence(container, cart)
  assert.ok(evidence)
  await carts.updateCarts(cart.id, { metadata: { interfacer_purchase: evidence.purchase } })
  await carts.updateLineItems(evidence.lines.map(({ item, metadata }) => ({ id: item.id, metadata })))
  // A trusted/internal custom-price caller must not bypass the fixed quote.
  const line = cart.items?.[0]
  assert.ok(line)
  await carts.updateLineItems([{ id: line.id, unit_price: 0.01 }])
  try {
    const result = await completeCartWorkflow(container).run({ input: { id: cart.id }, throwOnError: false })
    assert.match(result.errors[0]?.error.message, /build_fixed_quote_price_required/)
    assert.equal((await carts.retrieveCart(cart.id)).completed_at, null)
  } finally {
    await carts.updateLineItems([{ id: line.id, unit_price: line.unit_price }])
  }
  assert.equal((await integration.listReaReceipts({ order_id: state.order.id })).length, 1)
  assert.equal((await integration.listReaReceipts({ order_id: state.payment_only.id })).length, 0)
  console.log("PASS immutable offer/acceptance/production receipt + unique order sink; direct workflow evidence/price bypass refused with fixture mode disabled; guarded internal actions refused.")
}
