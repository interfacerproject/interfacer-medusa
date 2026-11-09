# Interfacer × Medusa — local marketplace status

**Current extension (2026-10-23):** the GUI now supports verified Interfacer buyer
wallets and per-order live receivers; live build milestones record a real
Process/produce before handover. See [the bridge document](zenflows-bridge.md) for
setup, evidence and explicit limits. The P0–P6b baseline below describes the
standalone fixture mode and its historical nine-harness acceptance.

**P6b implementation: browser storefront + signed end-to-end journeys.**
Local development only, not a production marketplace or live Zenflows deployment.
[Commands, actual output and evidence](../TESTING.md#p6b--storefront--end-to-end).

## Run it

From this repository, with Docker running, Node **24** and Python **3**:

```bash
npm run dev:up
```

Wait for `STOREFRONT READY: http://localhost:9000/dev/store`, then open that URL.
The command installs locked Medusa dependencies if needed, creates/starts its
own PostgreSQL container, typechecks/migrates, seeds designs/services, registers
and binds a disposable demo customer, and signs the projection/publication/stock
setup of **three new one-unit synthetic resources**. No sold stock is replenished.
The page uses native Store product reads, with calculated EUR prices and DPP
references, restricted to this run's published demo resources.

Stop with **Ctrl-C**, or `npm run dev:down` in another terminal. Both stop only
the supervisor's Medusa PIDs and selected owned DB; data is retained. A new boot
creates a fresh demo view/customer/resources, retaining older immutable records.
No server is intentionally left running after verification.

## Exact click paths

### Stock resource → transfer receipt

1. Open **Catalog**. Read a product's resource ID, **DPP reference**, EUR 19.95
   price and available one-unit allocation.
2. Click **Buy** on an available unit. The already bound demo customer buys
   through native cart → system/manual payment → order; payment is really
   captured. The page shows the native order ID and **Order & passport evidence**.
3. Click **Mark delivered**. A signed seller operation performs native local
   pickup fulfillment and delivery. The page shows **VF receipt · transfer**.
4. Open **Full local ValueFlows receipt**, or scroll to **ValueFlows receipts**.
   Provider, receiver, resource, DPP, order, quantity **1** and time are persisted.

### Design → service → production receipt

1. Under **Build from a design**, choose **PETG organizer — synthetic design**.
   Open **Design requirements** if desired, then click **Match**.
2. Inspect compatible **Standard FDM — synthetic service** (EUR **19** for
   **2 pieces**) and Large precise FDM (EUR 36), their fixed quotes, provider,
   capabilities and hashes. **Incompatible services & reasons** explains rejects.
3. Click **Buy build** for Standard FDM. This buys one complete quoted lot from
   one supplier, not two EUR-19 unit lines. The native order and actual captured
   upfront test payment appear. Payment alone creates **no VF event**.
4. Click **Mark produced**. A signed provider operation records the explicit
   production milestone; **VF receipt · produce** includes design, service,
   provider, buyer, origin DPP, quote/hash, order and quantity **2**.
5. Refresh/reload: receipts remain. Click **Match** again to redisplay the saved
   build order/receipt. The large PLA panel deliberately has no origin DPP:
   matching works, but **Buy build** is disabled with a reason.

## What is real versus local

| Real implementation | Labeled local boundary / not claimed |
| --- | --- |
| Medusa **2.10.3**, PostgreSQL migrations, native products/prices/carts/accounts/orders, managed stock, reservations, manual payment authorization/capture, native stock fulfillment/delivery | Synthetic resources, one-unit local allocations, no carrier or real-money provider |
| Real Node Ed25519 signatures over P6a canonical envelopes; controller/buyer/provider and actual operation parameters verified before protected writes; native checkout hook independently re-verifies | Key→Person resolution is the **LOCAL STAND-IN** registry. Customer/Person enrollment and resource/controller documents are trusted local setup, not remote identity/ownership proof |
| Deterministic structured capability matching, immutable hashed quotes/acceptances, one supplier per build, server-controlled prices | Synthetic services/capabilities/prices, no live supplier capacity or remote commitment; no quote expiry |
| Immutable, unique-per-order VF-shaped `transfer` / `produce` receipts; no receipt on payment; milestone retries reuse persisted facts | **LOCAL REA STAND-IN sink**, not a live Zenflows economic-event write. Build production is a signed explicit demo assertion, not machine proof. No successor DPP minted |
| Browser fetches real APIs, obtains actual envelopes and submits signature headers; no mocked commerce | **LOCAL DEV SIGNER** deliberately signs disposable fixture/dev keys on behalf of the selected demo actors. This is NOT a production wallet or supplier login |

The storefront, config, assets, signer and capture routes require BOTH
`signed-envelope-local` and `INTERFACER_DEV_STOREFRONT=true`, reject production,
non-loopback sockets, unexpected Host, cross-site and non-same-origin requests.
Signer/capture additionally require the actual demo customer's Medusa login.
No request can choose a private key, Person, price or arbitrary operation.
The demo login is intentionally disclosed locally; these controls do not make it
safe to expose publicly. No production key is used or returned to the browser.

`POST /dev/store/capture` is an explicitly new **dev-only** adapter over native
`capturePaymentWorkflow`, not a claimed built-in Store API. It also verifies a
fresh buyer signature (`commerce.order.dev.capture`, `{order_id}`). The signer
uses the existing P6a helper; ordinary business routes still verify independently.
No production/unsigned bypass was added to P6a.

P6a's limits remain: ±5-minute envelope window, no durable used-nonce registry,
no audience/revocation/delegation guarantees, no verified Zenroom/remote PDP
wire integration, no durable distributed event worker/outbox. Production use,
returns, escrow, royalties, remote stock synchronization and crash-at-every-step
recovery are not implemented or implied.

## Verification

**Re-verified 2026-10-23: `npm run test:all` green, all 9 suites**, including both
real HTTP receipts and driven Chromium journeys at desktop/mobile widths.
Both owned P6b databases are stopped and no server/browser process is left running.

```bash
npm run test:all
```

Runs `npm test`, `test:http`, `test:p1` through `test:p5`, `test:p6a`, then
`test:p6b` sequentially with cleanup between. P6b itself boots **the same
`dev:up` command**, curls the page/APIs, exercises both signed journeys and
receipts, and drives **real Chromium clicks at 1440px and 390px**, including
reload/persisted receipt checks. Browser dependencies/cache stay in this project.
[Evidence and cleanup](../TESTING.md#p6b--storefront--end-to-end).

Orchestrator ledger verification is separate; no ledger DONE entry is fabricated.
