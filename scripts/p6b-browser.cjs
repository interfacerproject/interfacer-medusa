// Real browser clicks, no request mocking or injected orders/signatures.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const results = []
  try {
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport })
      const page = await context.newPage()
      page.setDefaultTimeout(60000)
      const errors = [], signed = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => {
        const proof = request.headers()['x-interfacer-auth']
        if (proof) signed.push(JSON.parse(Buffer.from(proof, 'base64url').toString()).envelope.op)
      })
      await page.goto('http://localhost:9000/dev/store')
      await page.locator('#status').filter({ hasText: 'Ready.' }).waitFor()
      assert.equal(await page.locator('#error').isVisible(), false)
      assert(await page.getByText('LOCAL DEV — fixture/dev keys, not production', { exact: true }).isVisible())
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      const title = await page.locator('#products > article:has(button:not([disabled]))').first().getByRole('heading').textContent()
      // Stable resource locator: the Buy button disappears after the milestone.
      const item = page.locator('#products > article').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
      await item.getByRole('button', { name: 'Buy', exact: true }).click()
      await item.getByRole('button', { name: 'Mark delivered', exact: true }).waitFor()
      assert.equal(await item.locator('.receipt').count(), 0, 'payment alone must not render a receipt')
      await item.getByRole('button', { name: 'Mark delivered', exact: true }).click()
      await item.locator('.receipt[data-action="transfer"]').waitFor()
      const stock = JSON.parse(await item.locator('.receipt pre').textContent())
      assert.equal(stock.action, 'transfer')
      assert.equal(stock.quantity, 1)
      assert(stock.id && stock.order_id && stock.dpp_id && stock.receiver_id && stock.provider_id)

      const design = page.locator('#designs > article').filter({ has: page.getByRole('heading', { name: 'PETG organizer — synthetic design', exact: true }) })
      await design.getByRole('button', { name: 'Match', exact: true }).click()
      const service = design.locator('article').filter({ has: page.getByRole('heading', { name: 'Standard FDM — synthetic service', exact: true }) })
      await service.getByRole('button', { name: 'Buy build', exact: true }).click()
      await service.getByRole('button', { name: 'Mark produced', exact: true }).waitFor()
      assert.equal(await service.locator('.receipt').count(), 0)
      await service.getByRole('button', { name: 'Mark produced', exact: true }).click()
      await service.locator('.receipt[data-action="produce"]').waitFor()
      const build = JSON.parse(await service.locator('.receipt pre').textContent())
      assert.equal(build.action, 'produce')
      assert.equal(build.quantity, 2)
      assert.equal(build.service_id, 'ifsvc_p4_standard')
      assert.equal(build.receiver_id, stock.receiver_id)
      for (const op of ['commerce.order.authorize', 'commerce.order.build.purchase', 'commerce.order.deliver', 'commerce.order.produce', 'commerce.order.dev.capture']) assert(signed.includes(op), `missing signed ${op}`)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.deepEqual(errors, [])
      // Reload verifies native orders/receipt display and sold inventory survive.
      await page.reload()
      await page.locator('#status').filter({ hasText: 'Ready.' }).waitFor()
      await page.locator('#receipt-list .receipt').filter({ hasText: build.id }).waitFor()
      await page.locator('#receipt-list .receipt').filter({ hasText: stock.id }).waitFor()
      await design.getByRole('button', { name: 'Match', exact: true }).click()
      await service.locator('.receipt[data-action="produce"]').waitFor()
      assert.equal(JSON.parse(await service.locator('.receipt pre').textContent()).id, build.id)
      await page.evaluate(() => scrollTo(0, 0))
      await page.screenshot({ path: path.join('.tmp', `p6b-${name}.png`), fullPage: true })
      results.push({ viewport: name, signed_operations: [...new Set(signed)], stock, build })
      console.log(`PASS P6b BROWSER ${name}: clicked Buy → Mark delivered → ${stock.id}; Match → Buy build → Mark produced → ${build.id}; reload + no horizontal overflow/errors`)
      await context.close()
    }
    fs.writeFileSync('.tmp/p6b-browser-results.json', JSON.stringify(results, null, 2) + '\n')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
