# Payments and after-sale (release 4ku.1 / 4ku.2)

Real payments through **Stripe Connect direct charges**: the buyer pays the
**seller directly**, on the seller's own Stripe account, and Interfacer's
**commission** is deducted by Stripe as an application fee. Plus the
after-sale services: **cancellations, returns and refunds**. Beads:
`interfacer-gui-4ku.1`, `interfacer-gui-4ku.2`.

Without `STRIPE_SECRET_KEY` nothing changes: the marketplace keeps Medusa's
system (test) provider, as in the pilot. After-sale requests, cancellations
and refunds work in both modes.

## The money model (owner decision, 2026-11-26)

```
buyer ──card──▶ seller's own Stripe account ──payout──▶ seller's bank
                        │
                        └── application fee (commission) ──▶ Interfacer's Stripe account
```

- **The seller is the merchant of record.** Each seller or maker opens a
  **Standard** Stripe account (their own, full account) on Stripe's hosted
  onboarding; identity, bank account and tax details never pass through
  Interfacer. They see their sales, refunds, disputes and payouts in their own
  Stripe dashboard, pay Stripe's processing fees and handle disputes.
- **Commission.** `INTERFACER_PLATFORM_FEE_BPS` (basis points, 800 = 8 %)
  plus an optional `INTERFACER_PLATFORM_FEE_FIXED_CENTS`, rounded to the cent,
  never above the price. It is the PaymentIntent's `application_fee_amount`:
  Stripe moves it to Interfacer when the payment is captured. Sellers **sign**
  the terms in force (`commerce.payouts.onboard`, with `terms_version`);
  checkout **freezes** them on the order (`order.metadata.interfacer_settlement`).
  A later change never touches an existing order; sellers sign again before
  they can sell.
- **When the buyer is charged.** The payment is **authorized** at checkout.
  - **Products: captured at the signed delivery.** Until then nothing is
    charged; a cancellation only releases the authorization. Stripe releases
    an uncaptured authorization after **7 days**: an order not delivered by
    then is canceled automatically and its unit is for sale again. The seller
    sees the "deliver by" date.
  - **Builds: captured as soon as the order exists** (production may take
    longer than an authorization lasts).
- **Refunds give the commission back** in proportion (`refund_application_fee`):
  a full refund returns all of it, a 5.00 refund on a 19.95 sale 0.40 of the
  1.60. The refund is made on the seller's account (their balance pays it).

### Guarantees (and where they are enforced)

| Guarantee | Where |
|---|---|
| The buyer is never asked to pay a seller who cannot be paid (no account, onboarding unfinished, terms not signed) | `/market/store/payment`, the pre-payment check in `/market/store/prepare`, the build acceptance; again at completion (`checkoutSettlement`) |
| The seller's account and the commission are computed by the server, never by the client | sessions for `pp_stripe_stripe` only via `/market/store/payment`; the native `POST /store/payment-collections/:id/payment-sessions` refuses that provider (`use_market_payment_route`); the provider refuses a session without the marketplace's terms |
| The cart is completed only with an authorized PaymentIntent on **that** seller's account, for **that** total and **that** commission, manual capture | checkout middleware `verifyStripePayment` (also avoids the Medusa 2.10.3 reservation leak, [interfacer-medusa#5](https://github.com/interfacerproject/interfacer-medusa/issues/5)) |
| With Stripe on, an order cannot be completed with the test provider | the same check; completion hook `requireMarketPaymentSessions`; the region only offers `pp_stripe_stripe` |
| A product is charged only when the seller signs its delivery; never while a cancellation request waits | `assertMilestoneAllowed` captures under the order's settlement lock |
| A build is produced only once paid | `produceBuild` requires the captured payment |

## After-sale services

Every step is a signed operation of the person who takes it; Medusa checks
that person is the order's buyer or seller.

| Step | Who | Signed op and params | Effect |
|---|---|---|---|
| Ask to cancel | buyer | `commerce.order.case.open` `{order_id, kind: "cancellation", reason}` | only before the milestone; the seller must answer before delivering (`aftersale_cancellation_pending`) |
| Ask to return | buyer | same, `kind: "return"` | only after the milestone, within `INTERFACER_RETURN_WINDOW_DAYS` (default 14) |
| Withdraw | buyer | `commerce.order.case.withdraw` `{order_id, case_id}` | while requested (or an accepted return) |
| Accept / decline | seller | `commerce.order.case.respond` `{order_id, case_id, decision, note}` | declining needs a note. **Accepting a cancellation cancels the order natively** (the unit is for sale again): a product's authorization is released (nothing was charged), a build is refunded in full |
| Item received back | seller | `commerce.order.case.returned` `{order_id, case_id, refund_cents, note}` | the physical-return fact (`returned_at`) and the refund; a partial refund needs a note |
| Refund | seller | `commerce.order.refund` `{order_id, amount_cents, reason}` | a goodwill/partial refund of a charged order |

One open case per order (database constraint). Refunds are native Medusa
refunds (a refund credit line, then `refundPaymentWorkflow`, which refunds on
the seller's Stripe account), tagged `interfacer:<refund id>` so an interrupted
refund is resumed, never repeated. The physical return and the financial
refund stay separate rows, as `interfacer-gui-4ku.2` asks.

## API

All under `/market`, through the GUI proxy. Reads need the person's Medusa
session; writes carry the person's signature (the body is the signed params).

| Route | |
|---|---|
| `GET /market/store/config` | adds `payments: {provider, provider_id, publishable_key, live, terms, return_window_days, charges: "direct", capture, authorization_days}` |
| `POST /market/store/payment` `{cartId}` | the buyer's session: `{client_secret, stripe_account, amount_cents}`; Stripe.js is initialized with `stripe_account` |
| `POST /market/store/capture` | the buyer's signed capture step: builds are captured, products answer `{captured: false, capture_at: "delivery"}` |
| `GET /market/store/payouts` | the seller's account status (live from Stripe), the terms in force and signed, `dashboard_url` |
| `POST /market/store/payouts/onboard` | `commerce.payouts.onboard`: creates the Standard account once, returns a fresh onboarding link until it can take payments |
| `GET /market/orders/:id/aftersale` | cases, refunds, `captured`, what the caller may do now |
| `POST /market/orders/:id/cases` and `…/cases/:case/{withdraw,respond,returned}` | the steps above |
| `POST /market/orders/:id/refunds` | seller refund |
| `GET /market/store/seller` | each order now has `paid`, `capture_by` (products) and `open_case`; plus `cases` |
| `POST /hooks/payment/stripe_stripe` | Medusa's payment webhook (a **Connect** endpoint); in a pilot only via the GUI relay `/api/market-hooks/stripe` |

## Configuration

| Variable | |
|---|---|
| `STRIPE_SECRET_KEY` | the platform's key; turns real payments on. `sk_test_…` (or a restricted key). In a pilot, a live key also needs `INTERFACER_LIVE_PAYMENTS=true` |
| `STRIPE_PUBLISHABLE_KEY` | the platform's `pk_test_…`/`pk_live_…`, same mode as the secret key; sent to browsers |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` of the Connect webhook endpoint below |
| `INTERFACER_GUI_URL` | the GUI's public URL; Stripe sends sellers back to `/market/selling` |
| `INTERFACER_PLATFORM_FEE_BPS`, `INTERFACER_PLATFORM_FEE_FIXED_CENTS` | the commission (0–5000 bps, 0–10000 cents) |
| `INTERFACER_SELLER_TERMS_VERSION` | bump it whenever the commission or terms change: sellers sign again |
| `INTERFACER_RETURN_WINDOW_DAYS` | days after the milestone a return may be asked (0–90, default 14) |
| `STRIPE_API_BASE` | tests only (the local Stripe stand-in); refused in production |

Medusa refuses to start with a half-configured Stripe (`payment_config_invalid: …`).

### Stripe dashboard, once

1. Connect → set up the platform for **Standard** accounts, in the countries
   the marketplace serves (AT, BE, DE, DK, ES, FI, FR, GR, IE, IT, NL, PL, PT, SE).
2. Branding (name, icon, colour) for the onboarding pages.
3. Developers → Webhooks → a **Connect** endpoint ("events on connected
   accounts") `https://<gui>/api/market-hooks/stripe`, events
   `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `payment_intent.canceled`. Its signing
   secret is `STRIPE_WEBHOOK_SECRET`.
4. Payment methods: the Payment Element shows those the seller's account has
   enabled that support **manual capture** (cards and wallets; not SEPA debit).

## Operating it

- `docker compose exec medusa interfacer-medusa exec ./src/scripts/money-report.js`
  runs the money step once (finish interrupted refunds, cancel product orders
  whose authorization lapsed) and lists pending refunds and open cases. The
  scheduled job `interfacer-money` does the same every 5 minutes.
- Fees collected: Stripe dashboard → Connect → Collected fees.
- A seller who stays "to finish": Stripe still wants details
  (`requirements_due` in `GET /market/store/payouts`); they continue from
  *Selling → Getting paid*.
- Disputes (chargebacks) go to the seller's Stripe account; the application
  fee is not returned automatically on a dispute.

## Verification

- `npm run test:unit` (Medusa): commission arithmetic, configuration checks,
  case lifecycle, the direct-charge provider (intent on the seller's account
  with the fee, capture/cancel/refund on that account, refund gives the fee
  back, amounts as BigNumbers), the pre-completion check (amount, fee, account,
  capture method, status).
- `npm run test:payments`: **a real Medusa on a real Postgres** with Stripe
  replaced by `scripts/stripe-stub.cjs` (Stripe's HTTP API, encoding,
  `Stripe-Account` scoping, idempotency, application fees and their
  proportional refund). It drives: refusal before onboarding; a client-made
  Stripe session refused; onboarding of a Standard account with signed terms;
  an unconfirmed payment refused before any reservation; authorization on the
  seller's account with the 1.60 fee; nothing charged until delivery, then
  19.95 charged and 1.60 to Interfacer; return → full refund with the fee
  back; cancellation before delivery releases the authorization and frees the
  unit; a partial refund returns 0.40 of the fee; a build charged at order;
  a lapsed authorization cancels the order. At the end Interfacer keeps exactly
  the commission on what was not refunded and the sellers' balances match.
  Docker by default; `PAYMENTS_PROBE_DB=external DATABASE_URL=…` uses an
  existing empty Postgres.
- GUI: `pnpm run test:market` (prepare → pay → capture at delivery, resume
  after a bank redirect, refused payment, after-sale signing; webhook relay).

**Not verified here:** a run against Stripe's real test mode (needs keys) and
the GUI in a browser with Stripe.js (needs a publishable key and a running
Zenflows). Do both on staging before turning real money on.

## Not in this slice (follow-ups)

- **Zenflows record of a return.** The returned item's transfer back to the
  seller is a fact signed by the seller in Medusa (`returned_at`), not yet a
  ValueFlows event: the buyer is the resource's custodian and would have to
  sign it with enforced authz.
- **Partial fulfillment** (a build lot delivered in parts).
- **Disputes**: an escalation path when a seller does not answer a request;
  the operator sees open cases in the money report (operator UI `4ku.8`).
- **Buyer confirmation of receipt** (`4ku.3`).
- Linking an **existing** Stripe account (OAuth) instead of opening a new one.
- Invoices and VAT: each seller invoices their own sales; Interfacer invoices
  its commission to sellers.
