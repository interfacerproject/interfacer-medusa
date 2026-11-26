# Payments, payouts and after-sale (release 4ku.1 / 4ku.2)

Real payments through **Stripe Connect** with a **platform commission**, the
sellers' and makers' own Stripe accounts, and the after-sale services:
**cancellations, returns and refunds**. Beads: `interfacer-gui-4ku.1`,
`interfacer-gui-4ku.2`.

Without `STRIPE_SECRET_KEY` nothing changes: the marketplace keeps Medusa's
system (test) provider, as in the pilot. After-sale requests, cancellations
and refunds work in both modes; payouts only exist with Stripe.

## The money model

```
buyer ──card──▶ Stripe (platform account) ──transfer (net of commission)──▶ seller's Express account ──payout──▶ seller's bank
                       │ authorized at checkout, captured once the order exists
                       └─ commission stays on the platform balance
```

- **Merchant of record: the platform.** The buyer pays the platform (Stripe
  "separate charges and transfers"). Each seller or maker has their **own
  Stripe Express account**: Stripe hosts their onboarding (identity, bank
  account, tax details) and dashboard; none of it passes through Interfacer.
  The platform pays Stripe's processing fees and carries negative balances
  (`controller.fees.payer = application`, `controller.losses.payments = application`).
- **Commission.** `INTERFACER_PLATFORM_FEE_BPS` (basis points, 800 = 8 %)
  plus an optional `INTERFACER_PLATFORM_FEE_FIXED_CENTS`, rounded to the cent
  and never above the price. Sellers **sign** the terms in force
  (`commerce.payouts.onboard`, with `terms_version`); checkout **freezes** them
  on the order (`order.metadata.interfacer_settlement`). A later fee change
  never touches an existing order; it asks sellers to sign again before they
  can sell.
- **When the seller is paid.** The sale is economically complete at the
  signed milestone (delivery for a product, production + handover for a
  build), as before. A **payout** row is created then, and the seller's share
  is transferred `INTERFACER_PAYOUT_HOLD_DAYS` (default 14) days later, and
  only while no after-sale request is open on the order. Stripe then pays it
  out to the seller's bank on their own schedule.
- **Checkout = authorize, then capture.** The PaymentIntent uses manual
  capture: the buyer authorizes it in Stripe's Payment Element, the order is
  placed, and the buyer's signed capture step captures it (as with the test
  provider). An order that is refused after the buyer authorized leaves no
  charge: the authorization is released.

### Guarantees (and where they are enforced)

| Guarantee | Where |
|---|---|
| A buyer is never charged for a seller who cannot be paid (no account, onboarding unfinished, terms not signed) | the pre-payment check in `/market/store/prepare` and the build acceptance; again at completion (`checkoutSettlement`) |
| With Stripe on, an order cannot be completed with the test provider | completion hook `requireMarketPaymentSessions`; the region only offers `pp_stripe_stripe` |
| The cart is completed only once Stripe says the payment is authorized | checkout middleware `requireAuthorizedStripePayment` (see *Medusa 2.10.3 finding* below) |
| No delivery or production of an unpaid order | `assertMilestoneAllowed` (captured Stripe payment) |
| A seller is paid once, at most the net share, from that order's own charge | payout row unique per order; `source_transaction` = the order's charge; Stripe idempotency key plus a `transfer_group` lookup before any re-send; a duplicate blocks for an operator |
| A refund takes the seller's share back proportionally | held payout shrinks or is canceled; a transferred one is partly reversed (`transfers.createReversal`) |

### Medusa 2.10.3 finding

`completeCartWorkflow` reserves the stock **before** it authorizes the payment,
and when authorization fails the inventory level keeps `reserved_quantity`
although no reservation row is left to release it. With one-unit listings a
single declined or unconfirmed card would make the unit unsellable. The
checkout middleware therefore asks Stripe for the PaymentIntent's status and
refuses (`payment_not_authorized`) before the workflow runs. Found by the
payments probe; worth reporting upstream.

## After-sale services

Every step is a signed operation of the person who takes it; Medusa checks
that person is the order's buyer or seller.

| Step | Who | Signed op and params | Effect |
|---|---|---|---|
| Ask to cancel | buyer | `commerce.order.case.open` `{order_id, kind: "cancellation", reason}` | only before the milestone; the seller must answer before delivering (`aftersale_cancellation_pending`) |
| Ask to return | buyer | same, `kind: "return"` | only after the milestone, within `INTERFACER_RETURN_WINDOW_DAYS` (default 14); the payout waits |
| Withdraw | buyer | `commerce.order.case.withdraw` `{order_id, case_id}` | while requested (or an accepted return) |
| Accept / decline | seller | `commerce.order.case.respond` `{order_id, case_id, decision, note}` | declining needs a note. **Accepting a cancellation cancels the order natively** (reservation released: the unit is for sale again) **and refunds in full** |
| Item received back | seller | `commerce.order.case.returned` `{order_id, case_id, refund_cents, note}` | the physical-return fact (`returned_at`) and the refund; a partial refund needs a note |
| Refund | seller | `commerce.order.refund` `{order_id, amount_cents, reason}` | a goodwill/partial refund at any time after payment |

One open case per order (database constraint). Refunds are native Medusa
refunds (a refund credit line, then `refundPaymentWorkflow`, which refunds on
Stripe), tagged `interfacer:<refund id>` so an interrupted refund is resumed,
never repeated. The physical return and the financial refund stay separate
rows, as `interfacer-gui-4ku.2` asks.

## API

All under `/market`, through the GUI proxy. Reads need the person's Medusa
session; writes carry the person's signature (the body is the signed params).

| Route | |
|---|---|
| `GET /market/store/config` | adds `payments: {provider, provider_id, publishable_key, live, terms, hold_days, return_window_days}` |
| `GET /market/store/payouts` | the seller's account status (live from Stripe), terms signed and in force, payouts |
| `POST /market/store/payouts/onboard` | `commerce.payouts.onboard`: creates the Express account once, returns a fresh onboarding link |
| `POST /market/store/payouts/dashboard` | `commerce.payouts.dashboard`: a login link to the seller's Express dashboard |
| `GET /market/orders/:id/aftersale` | cases, refunds, what the caller may do now (buyer) or the payout (seller) |
| `POST /market/orders/:id/cases` and `…/cases/:case/{withdraw,respond,returned}` | the steps above |
| `POST /market/orders/:id/refunds` | seller refund |
| `GET /market/store/seller` | each order now carries `payout` and `open_case`; plus `cases` |
| `POST /hooks/payment/stripe_stripe` | Medusa's native Stripe webhook; in a pilot only via the GUI relay `/api/market-hooks/stripe` |

## Configuration

| Variable | |
|---|---|
| `STRIPE_SECRET_KEY` | turns real payments on. `sk_test_…` (or a restricted key). In a pilot, a live key also needs `INTERFACER_LIVE_PAYMENTS=true` |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…`/`pk_live_…`, the same mode as the secret key; sent to browsers |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` of the webhook endpoint below |
| `INTERFACER_GUI_URL` | the GUI's public URL; Stripe sends sellers back to `/market/selling` |
| `INTERFACER_PLATFORM_FEE_BPS`, `INTERFACER_PLATFORM_FEE_FIXED_CENTS` | the commission (0–5000 bps, 0–10000 cents) |
| `INTERFACER_SELLER_TERMS_VERSION` | bump it whenever the commission or terms change: sellers sign again |
| `INTERFACER_PAYOUT_HOLD_DAYS` | days between the milestone and the transfer (0–90, default 14) |
| `INTERFACER_RETURN_WINDOW_DAYS` | days after the milestone a return may be asked (0–90, default 14) |
| `STRIPE_API_BASE` | tests only (the local Stripe stand-in); refused in production |

Medusa refuses to start with a half-configured Stripe (`payment_config_invalid: …`).

### Stripe dashboard, once

1. Connect → set up the platform; enable **Express** accounts for the
   countries the marketplace serves (the GUI offers AT, BE, DE, DK, ES, FI,
   FR, GR, IE, IT, NL, PL, PT, SE).
2. Branding (name, icon, colour) for the onboarding pages.
3. Developers → Webhooks → endpoint `https://<gui>/api/market-hooks/stripe`,
   events `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `payment_intent.canceled`,
   `payment_intent.processing`, `payment_intent.partially_funded`. Its signing secret is
   `STRIPE_WEBHOOK_SECRET`.
4. Payment methods: the Payment Element shows those enabled in the dashboard
   that support **manual capture** (cards, wallets; not SEPA debit).

## Operating it

- `docker compose exec medusa interfacer-medusa exec ./src/scripts/money-report.js`
  runs the money step once (finish interrupted refunds, create missing payouts,
  transfer due ones) and lists blocked/held payouts, pending refunds and open
  cases. The scheduled job `interfacer-payouts` does the same every 5 minutes.
- A **blocked** payout (`last_error`) needs a person: e.g. two transfers found
  for one payout, or the transfer went to another account. Compare with the
  Stripe dashboard (Connect → the account → Transfers, group = the order id).
- A seller who stays "to finish": Stripe still wants details
  (`requirements_due` in `GET /market/store/payouts`); they continue from
  *Selling → Getting paid*.

## Verification

- `npm run test:unit` (Medusa): commission and refund-share arithmetic,
  configuration checks, case lifecycle, payout transfer, reconciliation after a
  lost response, retry/backoff and duplicate blocking.
- `npm run test:payments`: **a real Medusa on a real Postgres** with Stripe
  replaced by `scripts/stripe-stub.cjs` (Stripe's HTTP API, encoding,
  idempotency and money rules for the calls used). It drives: refusal before
  onboarding; onboarding with signed terms; refusal of a test-provider
  session and of an unconfirmed payment; authorize → order → capture; delivery
  → transfer of 19.95 − 8 % = 18.35 from the order's charge, never twice;
  return → accept → item back → full refund and full reversal; cancellation
  pending blocks delivery, accepting cancels the order, refunds and frees the
  unit; a partial refund before the payout shrinks the transfer; a build pays
  the maker. At the end the platform keeps exactly the commission on what was
  not refunded. Docker by default; `PAYMENTS_PROBE_DB=external
  DATABASE_URL=…` uses an existing empty Postgres.
- GUI: `pnpm run test:market` (client: pre-payment check, confirm, resume after
  a bank redirect, refused payment, after-sale signing; webhook relay).

**Not verified here:** a run against Stripe's real test mode (needs keys) and
the GUI in a browser with Stripe.js (needs a publishable key and a running
Zenflows). Do both on staging before turning real money on.

## Not in this slice (follow-ups)

- **Zenflows record of a return.** The returned item's transfer back to the
  seller is a fact signed by the seller in Medusa (`returned_at`), not yet a
  ValueFlows event: the buyer is the resource's custodian and would have to
  sign it with enforced authz.
- **Partial fulfillment** (a build lot delivered in parts, a receipt per
  part): orders stay one unit / one lot.
- **Disputes and chargebacks** (`charge.dispute.*`), and an escalation path
  when a seller does not answer a request: today the operator sees open cases
  in the money report. Belongs with the operator UI (`4ku.8`).
- **Buyer confirmation of receipt** (`4ku.3`) would replace the hold period
  as the release trigger.
- Invoices/receipts for buyers, VAT handling, and sellers' 1099/DAC7
  reporting (Stripe provides the latter for Express accounts).
