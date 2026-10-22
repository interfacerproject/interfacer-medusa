import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import type { ExecArgs, IPaymentModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { capturePaymentWorkflow } from "@medusajs/medusa/core-flows"
import { INTERFACER_MODULE } from "../modules/interfacer"
import type InterfacerService from "../modules/interfacer/service"

export default async function verify({ container, args }: ExecArgs) {
  const state = JSON.parse(await readFile("../.tmp/p3-state.json", "utf8"))
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  if (args[0] === "capture") {
    assert.equal((await integration.listReaReceipts({ order_id: state.order_id })).length, 0)
    await capturePaymentWorkflow(container).run({ input: { payment_id: state.payment_id } })
    const payments = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
    const payment = await payments.retrievePayment(state.payment_id)
    assert.ok(payment.captured_at)
    assert.equal((await integration.listReaReceipts({ order_id: state.order_id })).length, 0)
    console.log(`PASS NO RECEIPT ON CAPTURE: payment=${payment.id} captured_at=${new Date(payment.captured_at).toISOString()}; order still has zero receipts.`)
  } else {
    const [receipt] = await integration.listReaReceipts({ order_id: state.order_id })
    assert.ok(receipt)
    await assert.rejects(() => integration.createReaReceipts({
      action: "transfer", provider_id: receipt.provider_id, receiver_id: receipt.receiver_id,
      resource_id: receipt.resource_id, dpp_id: receipt.dpp_id, order_id: receipt.order_id,
      quantity: receipt.quantity, has_point_in_time: receipt.has_point_in_time,
    }), /unique|duplicate|already exists/i)
    await assert.rejects(() => integration.updateReaReceipts({ id: receipt.id, receiver_id: "forged" }), /interfacer_immutable/)
    await assert.rejects(() => integration.softDeleteReaReceipts([receipt.id]), /interfacer_immutable/)
    await assert.rejects(() => integration.deleteReaReceipts([receipt.id]), /interfacer_immutable/)
    assert.equal((await integration.listReaReceipts({ order_id: state.order_id })).length, 1)
    console.log("PASS receipt DB uniqueness + immutable update/soft-delete/delete guards; exactly one receipt remains.")
  }
}
