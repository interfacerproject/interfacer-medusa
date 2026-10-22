// Browser client: every protected action gets a real, fresh P6a envelope from
// the visibly labeled, separately enabled LOCAL DEV signer. No private keys here.
const $ = (id) => document.getElementById(id)
let scene, token, storageKey, journeys = {}
const euro = (n) => new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' }).format(n)
const orderFields = '+customer_id,+metadata,+items.metadata,+payment_collections.payments.*,+payment_collections.payment_sessions.*,+fulfillments.*,+items.detail.*'
function el(tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}
function reference(parent, label, value) {
  const p = el('p', label + ': ', 'muted')
  p.append(el('code', value || 'Not supplied'))
  parent.append(p)
}
function detail(parent, label, value) {
  const details = el('details')
  details.append(el('summary', label), el('pre', JSON.stringify(value, null, 2)))
  parent.append(details)
}
function save() { localStorage.setItem(storageKey, JSON.stringify(journeys)) }
async function api(path, body, signature) {
  const headers = { 'Content-Type': 'application/json' }
  if (scene) headers['x-publishable-api-key'] = scene.context.publishable_key
  if (token) headers.Authorization = 'Bearer ' + token
  if (signature) headers['X-Interfacer-Auth'] = signature
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers,
    credentials: 'same-origin', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.message || result.reason || `HTTP ${response.status}`)
  return result
}
async function signed(path, body, action) {
  const proof = await api('/dev/store/sign', action)
  return api(path, body, proof.header)
}
async function readOrder(id) {
  return (await api(`/store/orders/${encodeURIComponent(id)}?` + new URLSearchParams({ fields: orderFields }))).order
}
function actionButton(label, work, errorArea) {
  const button = el('button', label)
  button.type = 'button'
  button.addEventListener('click', async () => {
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    button.textContent = 'Working…'
    errorArea.textContent = ''
    try { await work() }
    catch (error) {
      errorArea.textContent = `Could not finish: ${error.message}. Retry this action; saved cart/order IDs are reused. If stock was bought elsewhere, choose another demo unit.`
    } finally {
      button.disabled = false
      button.removeAttribute('aria-busy')
      button.textContent = label
    }
  })
  return button
}
async function newCart() {
  const cart = (await api('/store/carts', { region_id: scene.context.region_id,
    sales_channel_id: scene.context.sales_channel_id, email: scene.email,
    shipping_address: { first_name: 'Local', last_name: 'Demo', address_1: 'Teststrasse 1',
      city: 'Berlin', postal_code: '10115', country_code: 'de' } })).cart
  return (await api(`/store/carts/${cart.id}/customer`, {})).cart.id
}
async function purchase(state, kind, target) {
  if (!state.cartId) { state.cartId = await newCart(); save() }
  if (!state.orderId) {
    const cart = (await api(`/store/carts/${state.cartId}`)).cart
    if (!cart.completed_at) {
      if (kind === 'build') {
        await signed('/dev/interfacer/build-orders', { cartId: state.cartId, quoteId: target },
          { action: 'build', cartId: state.cartId, quoteId: target })
      } else if (!cart.items.length) {
        await api(`/store/carts/${state.cartId}/line-items`, { variant_id: target, quantity: 1 })
      }
      const collection = (await api('/store/payment-collections', { cart_id: state.cartId })).payment_collection
      await api(`/store/payment-collections/${collection.id}/payment-sessions`, { provider_id: 'pp_system_default' })
    }
    const result = await signed(`/store/carts/${state.cartId}/complete`, {}, { action: 'checkout', cartId: state.cartId })
    if (result.type !== 'order') throw new Error(result.error?.message || 'Order completion refused')
    state.orderId = result.order.id
    save() // keep the native order even if the separate financial capture fails
  }
  await signed('/dev/store/capture', { orderId: state.orderId }, { action: 'capture', orderId: state.orderId })
  state.captured = true
  save()
}
function showReceipt(parent, receipt) {
  const box = el('div', undefined, 'receipt')
  box.dataset.action = receipt.action
  box.append(el('h4', `VF receipt · ${receipt.action}`))
  reference(box, 'Receipt', receipt.id)
  reference(box, 'Provider → receiver', `${receipt.provider_id} → ${receipt.receiver_id}`)
  reference(box, 'Resource', receipt.resource_id)
  reference(box, 'DPP reference', receipt.dpp_id)
  box.append(el('p', `Quantity: ${receipt.quantity} · ${new Date(receipt.has_point_in_time).toLocaleString()}`))
  if (receipt.service_id) reference(box, 'Service', receipt.service_id)
  detail(box, 'Full local ValueFlows receipt', receipt)
  parent.append(box)
}
function journey(parent, kind, target, available = true) {
  const id = kind + ':' + target
  const state = journeys[id] ||= {}
  const panel = el('div', undefined, 'journey')
  const error = el('p', '', 'error')
  error.setAttribute('role', 'alert')
  const content = el('div')
  panel.append(content, error)
  parent.append(panel)
  async function render() {
    content.replaceChildren()
    if (!state.orderId) {
      const button = actionButton(kind === 'stock' ? 'Buy' : 'Buy build', async () => {
        try { await purchase(state, kind, target) } finally { await render() }
      }, error)
      button.disabled = !available
      if (!available) content.append(el('p', kind === 'stock' ? 'Sold out — this resource is not replenished.' : 'Origin DPP required — matching is available, but this build cannot be purchased.', 'muted'))
      else if (state.cartId) content.append(el('p', 'Saved cart — Buy resumes this checkout.', 'muted'))
      content.append(button)
      return
    }
    const order = await readOrder(state.orderId)
    const captured = order.payment_collections?.some(c => c.payments?.some(p => p.captured_at))
    const availability = parent.querySelector('.availability')
    if (availability) availability.textContent = 'Allocated to this order · one-unit resource'
    content.append(el('h4', 'Order placed'))
    reference(content, 'Native Medusa order', order.id)
    content.append(el('p', `${euro(order.total)} · ${captured ? 'Manual/test payment captured' : 'Manual/test payment authorized; capture pending'}`))
    detail(content, 'Order & passport evidence', order)
    if (!captured) {
      content.append(actionButton('Retry test payment capture', async () => {
        await purchase(state, kind, target); await render()
      }, error))
      return
    }
    if (state.receipt) { showReceipt(content, state.receipt); return }
    content.append(el('p', 'No VF event on payment. The next action asserts the physical milestone using a disposable seller/provider dev key.', 'muted'))
    content.append(actionButton(kind === 'stock' ? 'Mark delivered' : 'Mark produced', async () => {
      const action = kind === 'stock' ? 'deliver' : 'produce'
      const route = kind === 'stock' ? 'orders' : 'build-orders'
      const result = await signed(`/dev/interfacer/${route}/${order.id}/${action}`, {}, { action, orderId: order.id })
      state.receipt = result.receipt
      save()
      await render()
      await refreshReceipts()
    }, error))
  }
  return render()
}
async function catalog() {
  const query = new URLSearchParams({ region_id: scene.context.region_id, limit: '100',
    fields: 'id,title,metadata,variants.id,variants.manage_inventory,variants.inventory_quantity,variants.calculated_price.*' })
  for (const product of scene.products) query.append('id[]', product.product_id)
  const { products } = await api('/store/products?' + query)
  $('products').replaceChildren()
  if (!products.length) $('products').append(el('p', 'No published resource-backed products in this demo run. Restart dev:up to seed fresh units.'))
  for (const product of products) {
    const row = el('article', undefined, 'product-row')
    const info = el('div')
    info.append(el('h3', product.title))
    reference(info, 'Resource', product.metadata.interfacer_resource_id)
    reference(info, 'DPP reference', product.metadata.interfacer_dpp_id)
    const variant = product.variants[0]
    const amount = variant.calculated_price?.calculated_amount
    info.append(el('p', `Available: ${Math.max(0, variant.inventory_quantity ?? 0)} unit · synthetic local allocation`, 'muted availability'))
    row.append(info, el('p', amount == null ? 'Price unavailable' : euro(amount), 'price'))
    $('products').append(row)
    await journey(row, 'stock', variant.id, amount != null && variant.inventory_quantity > 0)
  }
}
async function designs() {
  const { designs } = await api('/dev/interfacer/designs')
  $('designs').replaceChildren()
  if (!designs.length) $('designs').append(el('p', 'No designs seeded. Restart the local demo.'))
  for (const design of designs) {
    const row = el('article')
    row.append(el('h3', design.name))
    reference(row, 'Origin DPP', design.origin_dpp_id)
    detail(row, 'Design requirements', design.requirements)
    if (!design.origin_dpp_id) row.append(el('p', 'Match only: this design has no origin DPP, so purchasing is disabled.', 'muted'))
    const error = el('p', '', 'error')
    error.setAttribute('role', 'alert')
    const matches = el('div')
    row.append(actionButton('Match', async () => {
      const result = await api('/dev/interfacer/match', { designId: design.id })
      matches.replaceChildren()
      if (!result.matches.length) matches.append(el('p', 'No compatible services. See the rejection reasons below.'))
      for (const { service, quote } of result.matches) {
        const match = el('article')
        match.append(el('h3', service.name), el('p', `${euro(quote.total_price_cents / 100)} for the complete lot of ${quote.quantity} pieces`, 'price'))
        reference(match, 'Provider', quote.provider_person_id)
        reference(match, 'Quote', quote.id)
        detail(match, 'Fixed quote, capabilities & hash', quote)
        matches.append(match)
        await journey(match, 'build', quote.id, Boolean(design.origin_dpp_id))
      }
      detail(matches, 'Incompatible services & reasons', result.rejected)
    }, error), error, matches)
    $('designs').append(row)
  }
}
async function refreshReceipts() {
  const { receipts } = await api('/dev/interfacer/receipts')
  const mine = receipts.filter(r => r.receiver_id === scene.buyer_person_id)
  $('receipt-list').replaceChildren()
  if (!mine.length) $('receipt-list').append(el('p', 'No receipts for this demo customer yet. Buy, then mark delivered or produced.', 'muted'))
  for (const receipt of mine) showReceipt($('receipt-list'), receipt)
}
async function connect() {
  $('error').hidden = true
  $('retry').hidden = true
  $('status').textContent = 'Connecting and loading the current demo run…'
  try {
    scene = await api('/dev/store/config')
    token = (await api('/auth/customer/emailpass', { email: scene.email, password: scene.password })).token
    storageKey = 'interfacer-storefront:' + scene.run
    try { journeys = JSON.parse(localStorage.getItem(storageKey) || '{}') } catch { journeys = {} }
    $('identity').textContent = `Bound demo customer: ${scene.email} · Person: ${scene.buyer_person_id}`
    await catalog()
    await designs()
    await refreshReceipts()
    $('status').textContent = 'Ready. Buy → order → mark delivered/produced → VF receipt. Every protected action is Ed25519-signed by the LOCAL DEV signer.'
  } catch (error) {
    $('status').textContent = 'Connection not ready.'
    $('error').textContent = `Could not load the demo: ${error.message}. Check the dev:up terminal, then retry.`
    $('error').hidden = false
    $('retry').hidden = false
  }
}
$('retry').addEventListener('click', connect)
$('refresh-receipts').addEventListener('click', async () => {
  try { await refreshReceipts() } catch (error) { $('error').textContent = error.message; $('error').hidden = false }
})
connect()
