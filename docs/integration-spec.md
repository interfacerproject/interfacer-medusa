# Interfacer–MedusaJS: First Integration Specification

**Status:** Proposed architecture and phased implementation plan  
**Scope:** Resource sales, design-to-fabrication matching, and commerce-to-ValueFlows reconciliation  
**Execution constraints:** Feature branches and draft PRs only; never main; no deployment  
**Repository root:** `/Users/euripide/dyne/interfacer-project`

## 1. Executive summary

Integrate Medusa as Interfacer’s **commerce engine**, not as a replacement for its identity, resource, passport, or ValueFlows systems.

- **Zenflows** remains authoritative for identities, resource control, EconomicResources, production processes, and economic events.
- **DPP** remains authoritative for passport documents and attachments.
- **Medusa** owns commercial products and variants, prices, carts, orders, payments, inventory reservations, and fulfillment.
- A small **Interfacer Commerce integration module** connects them through explicit mappings, authorization checks, durable jobs, and reconciliation.

The integration must support two distinct offer types:

1. **Stock offer:** Buy a physical resource represented in Interfacer, with its passport.
2. **Build offer:** Select a design, find a compatible fabrication service, and purchase a specific build configuration.

A design is not stock. A service tag is not proof of manufacturing compatibility. A paid order is not proof that production or delivery occurred.

The recommended first spike is:

> **Authorized EconomicResource + DPP → one Medusa draft product with one variant.**

This is the smallest useful cross-system slice. It establishes identity proof, resource authorization, immutable mappings, passport references, and retry-safe projection before introducing payment or ledger mutations.

Subsequent phases close the loop:

```text
Interfacer resource/design
    → authorized commercial offer
    → Medusa purchase
    → verified production/delivery milestone
    → authorized, idempotent Zenflows economic event
```

---

## 2. Repository findings and evidence

### 2.1 The checkout contains different implementation stages

The directories are not interchangeable snapshots.

- `zenflows/src/zenflows/authz/pdp.ex` is **absent** in the inspected base checkout.
- `zenflows-pdp-local/src/zenflows/authz/pdp.ex` contains the PDP.
- `zenflows-pdp-local` was inspected at `f5f59ca`, exposing `POST /authz/decide`.
- `zenflows-feedback-pdp` was inspected at `357298a`, extending identity resolution for feedback.
- `interfacer-dpp` is on `feat/authz-dpp-writes`, inspected at `197e4b7`.
- The inspected `interfacer-client` is on main; its DPP delete-signing behavior differs from `interfacer-client-dppdel-local`.

The guide explicitly describes a stack of feature branches and draft PRs, not a deployed baseline:

- `authz-field-guide/content/crossservice.mjs`

**Implementation prerequisite:** Pin compatible commits for each integration test environment. Do not assume these changes are merged or deployed.

### 2.2 Identity: registered Person keys, not commerce account claims

Verified sources:

- `zenflows-feedback-pdp/src/zenflows/vf/person.ex`
- `zenflows-feedback-pdp/src/zenflows/did.ex`
- `zenflows-feedback-pdp/src/zenflows/gql/mw/sign.ex`
- `interfacer-client/src/auth/AuthClient.ts`
- `interfacer-client/src/crypto/sign.ts`

`Zenflows.VF.Person` uses the `vf_agent` table and contains:

```text
id
user
email
eddsa_public_key
ecdh_public_key
other public-key fields
```

`Zenflows.DID` constructs identifiers of the form:

```text
did:dyne:<configured-spec>:<eddsa-public-key>
```

DID registration includes the Person identifier as `ifacer_id.identifier`.

GraphQL authentication resolves `zenflows-user` to a Person and verifies the request signature against that Person’s registered EdDSA key.

The SDK exposes:

- `signGraphQLRequest(body, store)` → `zenflows-sign`, `zenflows-user`, `zenflows-hash`
- `signDidRequest(body, store)` → `did-sign`, `did-pk`

Both use the existing Zenroom signing contract over the supplied request representation.

**Consequence:** A Medusa customer ID, email, or `x-user-id` header cannot establish an Interfacer identity. Account binding must prove possession of the registered key.

### 2.3 Resources: EconomicResource is broader than a physical SKU

Verified sources:

- `zenflows-feedback-pdp/src/zenflows/vf/economic_resource.ex`
- `interfacer-client/src/types/entities.ts`
- `interfacer-client/src/resources/ResourceClient.ts`
- `interfacer-client/src/graphql/operations.ts`

`Zenflows.VF.EconomicResource` contains, among other fields:

```text
name, note, images
classified_as
conforms_to
accounting_quantity
onhand_quantity
primary_accountable
custodian
tracking_identifier
repo, version, license, licensor, okhv
metadata
previous_event
```

The SDK’s `ProjectType` includes:

```ts
DESIGN = "Design"
PRODUCT = "Product"
SERVICE = "Service"
MACHINE = "Machine"
DPP = "DPP"
```

`Project.id` is documented as an EconomicResource ULID. `ResourceClient.specIdForType()` selects instance-specific ResourceSpecification IDs.

The `Project` abstraction includes:

- `linkedDesign`
- `derivedProducts`
- `dpp`
- `machines`
- `materials`
- `productFilters`
- `serviceFilters`

Importantly, `CREATE_PROJECT` creates a `produce` event with quantity `1`. That represents the project resource creation pattern; it does **not** prove that one physical item is available for sale.

**Consequence:** Catalog/design resources and saleable physical inventory must be distinguished explicitly. Never turn every resource’s quantity into Medusa stock automatically.

### 2.4 DPP: a separate document with a resource binding

Verified sources:

- `interfacer-dpp/internal/model/model.go`
- `interfacer-dpp/internal/handler/authz.go`
- `interfacer-dpp/internal/handler/handler.go`
- `interfacer-client/src/dpp/DppClient.ts`
- `interfacer-client/src/graphql/operations.ts`

The Go type `DigitalProductPassport` contains:

```text
ID
ProductID
BatchType / BatchID
CreatedBy
Status
CreatedAt / UpdatedAt
Attachments
ProductOverview
Reparability
EnvironmentalImpact
ComplianceAndStandards
Components
...
```

`ProductID` is the authorization parent used by the DPP PEP. The current update helper, `keepAuthzParent`, pins it to the stored value.

The SDK provides:

- `getDpp(id)`
- `listDpps({ productId, ... })`
- create/update/status/delete operations
- attachment operations
- QR and file URL helpers

A separate Zenflows resource of type DPP can also be created through `CREATE_DPP_RESOURCE`. Therefore:

> A MongoDB passport ID, a Zenflows DPP resource ID, and the product EconomicResource ID are different identifiers.

The bridge must not infer that they are interchangeable.

### 2.5 Authorization: one authority, local enforcement

Primary documentation:

- `zenflows-authz-docs/docs/cross-service-authz-decision.md`
- `zenflows-authz-docs/docs/cross-service-authz-contract.md`
- `zenflows-authz-docs/docs/cross-service-authz-transport-design.md`

Implementation:

- `zenflows-feedback-pdp/src/zenflows/authz/pdp.ex`
- `zenflows-feedback-pdp/src/zenflows/authz/pdp/transport.ex`
- `interfacer-dpp/internal/authz/authz.go`
- `interfacer-dpp/internal/handler/authz.go`

The ratified architecture is:

```text
service PEP
  → authenticate request
  → ask Zenflows PDP
  → enforce decision and obligations
  → execute local operation
```

The implemented PDP transport accepts a smaller shape than the full aspirational contract:

```json
{
  "request_id": "...",
  "action": "dpp.spec.update",
  "principal": { "pk": "..." },
  "binding": { "parent_id": "..." },
  "proof": {
    "signature": "...",
    "payload_b64": "..."
  }
}
```

The PDP independently verifies the user’s signature. Resource-control actions resolve the key to a Person and compare it with the stored resource controller. Feedback identity actions return the resolved Person as `subject`.

Important limitations verified in code:

- No commerce actions exist.
- The current transport does not implement operation-scoped delegation.
- It does not enforce the full signed action/object/nonce/timestamp envelope.
- The current resource-control PDP loader performs a direct controller comparison; do not assume it already supports every organization-membership rule used elsewhere.
- Pure contract vectors are not evidence that every transport-level field is enforced.
- The current DPP PEP rejects nonempty obligations because it cannot enforce them.

Shared vectors are in:

- `zenflows-feedback-pdp/docs/cross-service-authz/authn.json`
- `zenflows-feedback-pdp/docs/cross-service-authz/contract.json`

### 2.6 Satellite services are useful precedents, but not uniformly migrated

Verified examples:

| Service | Observed behavior |
|---|---|
| DPP | Four update/delete handlers call the PDP; create/upload/add-attachment are outside that wiring slice. |
| Feedback | `interfacer-feedback-authz/internal/auth/authz_middleware.go` uses the PDP-returned `subject`, ignoring `x-user-id`. |
| Inbox | `zenflows-inbox-authz/authz_outbox.go` verifies against the URL actor’s registered key and binds `activity.Actor`; it intentionally does not route this check through the PDP. |
| Wallet | Inspected `zenflows-wallet/wallet.go` still authenticates and calls `AddDiff` using request fields; the intended verified-event issuance policy is not established by that implementation. |

The architectural direction is shared, but a fully extracted and universally enforced PEP library should not be assumed.

**Consequence:** Do not use wallet points as payment, escrow, or settlement infrastructure. Do not copy its current issuance behavior into commerce.

### 2.7 Existing ValueFlows events have real resource effects

Verified sources:

- `zenflows-feedback-pdp/src/zenflows/vf/economic_event/type.ex`
- `zenflows-feedback-pdp/src/zenflows/vf/economic_event/domain.ex`
- `zenflows-feedback-pdp/src/zenflows/authz/event_policy.ex`
- `zenflows-feedback-pdp/src/zenflows/authz/event_facts.ex`

The existing GraphQL mutation is:

```text
createEconomicEvent(event: ..., newInventoriedResource: ...)
```

Supported event semantics include:

- `produce`
- `cite`
- `consume`
- `work`
- `deliverService`
- `transfer`
- `transferAllRights`
- `transferCustody`

`EconomicEvent.Domain.multi_insert` authorizes inside an Ecto transaction. Event facts lock relevant resources and control rows.

A `transfer` is not just an audit message:

- It checks accountability, custody, units, and other resource constraints.
- With no existing destination resource, it creates a receiver-side resource.
- It decrements the source’s accounting and on-hand quantities.
- The resulting event exposes `toResourceInventoriedAs`.

No commerce-specific external-event uniqueness facility was found in the inspected event implementation.

Commitment and fulfillment schema files exist, but their GraphQL imports are commented out in:

- `zenflows-feedback-pdp/src/zenflows/gql/schema.ex`

**Consequence:** Do not specify a call to an assumed `createCommitment` or `createFulfillment` API. An explicit extension would be required.

### 2.8 Frontend commerce is currently a preview, not an integration

Examples:

- `interfacer-gui/lib/previewCommerce/mockData.ts`
- `interfacer-gui/lib/previewCommerce/cart.ts`
- `interfacer-gui/pages/preview/commerce/cart.tsx`
- `interfacer-gui/pages/preview/commerce/order.tsx`

These are useful product references, but they use mock commerce data. They do not establish a working Medusa backend.

No Medusa application/configuration was found in the inspected package/config search.

---

## 3. Assumptions and decisions requiring confirmation

### 3.1 Proposed technical baseline

1. Use **Medusa v2**, pinned to an exact version during implementation.
2. Use its supported modules, workflows, API extensions, and subscribers—not direct writes to core commerce tables.
3. Keep the integration in one Medusa application initially.
4. Require a bound Interfacer Person for an Interfacer-backed checkout.
5. Start with:
   - one merchant of record;
   - one currency;
   - one supplier per order;
   - fixed-price offers;
   - whole-unit quantities;
   - manual/test payment and fulfillment providers.
6. Treat passport publication as an explicit seller-approved action.
7. Treat unattended delegation as new security work, not an existing capability.

These are recommendations, not verified owner decisions.

### 3.2 Version-verification gate

Before implementing Medusa adapters, verify against the pinned version:

- Product/variant creation workflows and metadata support.
- Customer authentication/session handling.
- Custom module links to products, variants, customers, and orders.
- Cart validation and completion extension points.
- Server-controlled pricing behavior.
- Inventory reservation behavior.
- Order, payment, fulfillment, cancellation, and refund event names.
- Subscriber retry and event-delivery guarantees.

This specification deliberately does not invent framework function names or assume a particular `order.completed` event exists.

---

## 4. Architecture

### 4.1 Component layout

```text
Interfacer GUI / Medusa storefront
        │
        ├── existing Interfacer SDK ──→ Zenflows / DPP
        │
        ├── proposed CommerceClient
        │          │
        │          ▼
        │   Interfacer Commerce API / PEP
        │   ┌───────────────────────────────────┐
        │   │ Custom Medusa integration module │
        │   │                                   │
        │   │ Identity links                    │
        │   │ Listing mappings                  │
        │   │ Match index / build offers        │
        │   │ Quotes / order-line snapshots     │
        │   │ Inbox / outbox / reconciliation   │
        │   └───────────────────────────────────┘
        │          │                  │
        │          ▼                  ▼
        │     Zenflows PDP       Zenflows GraphQL /
        │     /authz/decide       proposed receipt command
        │
        └── Medusa Store API ──→ carts / orders / payments / fulfillment

DPP REST ──→ authorized passport projection ──→ integration module

Medusa subscribers ──→ durable commerce signals ──→ reconciliation worker
```

### 4.2 Deployment boundary

Initially, the bridge is a **logical service inside the Medusa application**:

- Custom module: integration records and domain services.
- Custom routes: signed Interfacer operations.
- Workflows: orchestrate product projections and purchase checks.
- Subscribers: capture commerce lifecycle signals.
- Worker: reconcile durable jobs with Zenflows and DPP.

Its tables may use Medusa’s Postgres instance, but belong to the custom module.

Avoid an additional independently deployed bridge, message broker, and database in the first slice. Extract the module into a separate service only when operational needs justify it.

A reusable plugin/package can follow a stable interface; packaging is not the first goal.

### 4.3 Ownership boundaries

| Data | Authority | Integration behavior |
|---|---|---|
| Person identity and registered keys | Zenflows/DID infrastructure | Reference and verify |
| Resource control, memberships, policy epochs | Zenflows | Online authorization |
| Resource description, design revision, license | Zenflows | Approved projection to commerce |
| Passport sections and attachments | DPP | Reference plus public snapshot |
| Product merchandising and variant structure | Medusa | Linked to Interfacer sources |
| Prices, tax, shipping, discounts | Medusa | Never inferred from VF quantities |
| Carts, orders, payment state, fulfillment state | Medusa | Emit reconciliation signals |
| Physical stock history and resource quantities | Zenflows | Update through economic events |
| Commerce reservations and allocated sellable stock | Medusa | Bounded by explicit allocation |
| Manufacturing requirements/capabilities | Proposed typed Interfacer metadata | Indexed by bridge |
| Offer, quote, and order mapping | Integration module | Authoritative cross-system association |
| Production/delivery facts | Zenflows events | Created only from authorized evidence |

### 4.4 Direction of synchronization

```text
Zenflows → Medusa: approved resource/design/service projections
DPP      → Medusa: approved passport references and summaries
Medusa   → Zenflows: actual commerce-related economic events
```

Do not implement bidirectional synchronization of every field.

A Medusa title edit must not overwrite a resource’s canonical name. A resource update must not overwrite a price. A payment update must not mutate a passport.

---

## 5. Integration data model

All types in this section are **proposed additions**, not existing repository types.

### 5.1 IdentityLink

```text
id
medusa_instance_id
medusa_customer_id
zenflows_instance_id
person_id
verified_key_fingerprint
verified_at
status
```

Constraints:

- Unique active customer binding per Medusa instance.
- For the first integration, one customer per Person per instance.
- Bind to the stable Person ID, not permanently to a particular key.
- Key rotation and account recovery require an explicit policy.
- Never infer a link from matching email addresses.

### 5.2 ListingBinding

```text
id
kind: stock | build
catalog_resource_id
stock_resource_id?             # physical stock, when distinct from catalog
source_dpp_id?
source_dpp_resource_id?         # optional Zenflows DPP resource
seller_agent_id
medusa_product_id
medusa_variant_id
configuration_key
source_snapshot_hash
passport_snapshot_hash?
approved_revision
policy_version
permission_epoch
status: draft | active | suspended | archived
```

Key rules:

- Resource and passport bindings become immutable after creation.
- Rebinding means a new reviewed mapping, not an update hidden inside a sync.
- Verify `DPP.ProductID` against the declared passport-bound resource.
- Preserve all IDs separately.
- Use unique constraints for source/configuration-to-variant mappings.
- Medusa metadata contains discoverable IDs; the module’s records are authoritative.

### 5.3 Field mapping

| Interfacer field | Medusa representation | Rule |
|---|---|---|
| `EconomicResource.id` | Integration mapping; metadata reference | Never use as Medusa primary key |
| `name` | Initial product title | Source-owned projection unless explicit merchandising override |
| `note` | Sanitized description | Allowlisted, not raw HTML |
| `images` | Approved image URLs/assets | Respect accessibility and publication rights |
| `classified_as` | Selected tags/categories | Explicit translation table |
| `conforms_to` | Product-kind/reference metadata | Not a Medusa product type by automatic inference |
| `tracking_identifier` | Traceability reference | SKU only under an explicit uniqueness rule |
| `repo`, `version`, `license` | Public provenance metadata | Pin exact version for builds |
| Resource quantities | Stock allocation input | Never blindly mirror project quantity |
| DPP ID/status/hash | Passport link and public summary | DPP remains authoritative |
| Variant configuration | Medusa options/variant | Only commercially meaningful choices |
| Price/currency/tax | Medusa price and tax mechanisms | Commerce-owned |
| Seller/controller | Module relationships | Not editable customer metadata |

### 5.4 Product and variant strategy

For stock sales:

- One listing maps a catalog resource to a Medusa product.
- Each variant represents a specific saleable configuration.
- Each variant has an explicit physical stock mapping or allocation.
- Start with one product, one variant, one physical resource, quantity one.

For builds:

- The reusable design remains in Zenflows.
- A `BuildOffer` links a design revision to a particular supplier service.
- A Medusa product represents that supplier’s build offer.
- Variants represent a bounded set of supported configurations.

Do not create the Cartesian product of all designs, all services, and all possible configurations.

Do not create a new variant for every quote.

### 5.5 BuildOffer and Quote

```text
BuildOffer
  id
  design_resource_id
  design_revision_hash
  service_resource_id
  capability_revision_hash
  provider_agent_id
  configuration_schema_version
  medusa_product_id
  variant_mapping
  pricing_revision
  lead_time_terms
  acceptance_mode
  status

Quote
  id
  offer_id
  buyer_person_id
  configuration
  quantity
  currency
  price_breakdown
  design_revision_hash
  capability_revision_hash
  pricing_revision
  expires_at
  status
```

A quote is an immutable commercial snapshot. Changing the design, capability, price, or configuration creates a new quote.

### 5.6 OrderLineBinding and ledger receipts

```text
OrderLineBinding
  medusa_order_id
  medusa_line_item_id
  buyer_person_id
  seller_agent_id
  listing_id / offer_id / quote_id
  purchased_configuration
  source_resource_id
  source_dpp_id
  design_revision_hash?
  service_resource_id?
  quantity / unit_id
  price_snapshot
  fulfillment_allocations
  zenflows_process_id?
  zenflows_event_ids[]
  delivered_resource_ids[]
  ledger_status
```

Ledger status is independent of order/payment status:

```text
not_due
awaiting_authorization
pending
applied
blocked
reconciliation_required
```

---

## 6. Design-to-services matching

### 6.1 Existing metadata is discovery input, not sufficient capability data

Current `ServiceFilters` contains only:

```ts
serviceType: string[];
availability: string[];
```

Current `Project` includes machines and materials, but not a complete manufacturing capability model.

Add versioned, validated metadata schemas. Initial storage can use namespaced `EconomicResource.metadata`, through the existing authorized resource-update path:

```text
metadata.commerce.designRequirements
metadata.commerce.serviceCapabilities
```

These names and schemas are proposed.

The bridge maintains a rebuildable search index. It does not become the primary editor of resource facts.

### 6.2 Design requirements

Minimum schema:

```text
schema_version
design_revision
artifact_manifest: URLs + cryptographic hashes
required_processes
materials and acceptable alternatives
part dimensions and units
tolerance requirements
finish requirements
required certifications
quantity constraints
assembly / testing requirements
license identifiers and notices
```

A multi-part design may describe multiple operations, but the first matching release supports only a build that one provider can fulfill completely.

### 6.3 Service capabilities

Minimum schema:

```text
schema_version
provider_agent_id
service_resource_id
supported_processes
supported_materials
machine/work-envelope limits
achievable tolerances
supported finishes
certifications and evidence
minimum / maximum quantities
service area / shipping constraints
capacity availability
lead-time rules
pricing model revision
```

Separate:

- technical capability;
- currently available capacity;
- a supplier’s willingness to accept the job.

A capability match alone is not an accepted order.

### 6.4 Matching algorithm

Use deterministic rules first:

1. Validate both schemas.
2. Normalize dimensions, quantities, and units.
3. Check every mandatory process.
4. Check material compatibility.
5. Check dimensions against relevant machine limits.
6. Check tolerances and required finish.
7. Check certification and licensing prerequisites.
8. Check quantity, location, and delivery constraints.
9. Check available capacity.
10. Produce an explanation.

Result:

```text
compatible
incompatible
needs_review
```

Missing information produces `needs_review`, not an automatic match.

Only compatible candidates may receive an automatic fixed-price offer. Manual approval can resolve documented unknowns; it must not silently override hard safety or regulatory failures.

Example:

```text
Design:
  FDM, PETG, 180 × 120 × 60 mm, tolerance ±0.3 mm

Service A:
  FDM, PETG, 220 × 220 × 250 mm, tolerance ±0.2 mm
  → technically compatible

Service B:
  FDM, PLA only
  → incompatible: required material unsupported

Service C:
  FDM, PETG, tolerance unspecified
  → needs_review
```

Rank compatible candidates by disclosed criteria such as total price, lead time, and distance. Return reason codes and normalized inputs so the result is auditable.

### 6.5 Offer and price formation

First release: supplier-approved fixed-price configurations.

Later, an estimated base price may be computed from:

```text
setup
+ material
+ machine time
+ labor
+ finishing/testing
+ supplier margin
```

Tax, shipping, and permitted promotions remain Medusa responsibilities.

Requirements:

- Explicit currency and rounding rules.
- No binary-floating-point money calculations.
- Medusa-version-specific amount conventions verified in the adapter.
- Quote expiration.
- Clear distinction between estimate, accepted quote, and charged total.
- Supplier approval for uncertain estimates.
- No customer-provided line price accepted as authoritative.

At checkout, the server reloads the offer and quote, validates their ownership and revisions, and checks price, quantity, capacity, and expiration.

For the first fixed-price implementation, quote prices must match the active Medusa variant price. Dynamic quote pricing requires a separately verified server-controlled workflow; do not assume arbitrary cart metadata overrides pricing safely.

### 6.6 Build order representation

**Medusa side**

- Product/variant identifies the supplier build offer.
- Order line freezes the selected configuration and quote.
- Fulfillment identifies the responsible supplier.
- Payment reflects the commercial terms.

**Zenflows side**

- One build Process per order line or production lot.
- A `cite` event references the design when actually used.
- A `produce` event records the physical output when production occurs.
- A delivery/transfer event records the subsequent handover.

Do not record `produce` when the customer merely pays.

Do not transfer the design’s ownership when selling a manufactured copy.

Do not fabricate labor, material consumption, or contribution credits. Add those events only when there is real, authorized production evidence.

Initially, the accepted commercial obligation lives in the Medusa order and integration record. Exposing ValueFlows commitments and fulfillments is a later explicit extension.

---

## 7. Identity and authorization

### 7.1 Customer binding

A safe linking flow requires two independent proofs:

1. The caller controls the current Medusa customer session.
2. The caller controls an Interfacer key registered to a Person.

```text
Customer → Commerce API: request linking challenge
Commerce API → Customer: nonce, customer ID, audience, expiry
Customer → Commerce API: signed challenge
Commerce API → Zenflows PDP: proof for proposed commerce.identity.link
PDP → Commerce API: allow + proven Person subject
Commerce API → database: create unique IdentityLink
```

The signed challenge must bind:

- operation;
- customer ID;
- Medusa instance;
- audience;
- nonce;
- expiration.

Apply normal session and CSRF protections. A stolen DID signature for another operation must not link an account.

For the first implementation, linking augments existing Medusa authentication. A DID-native Medusa authentication provider is optional later work.

### 7.2 Proposed action registry

These actions do **not** exist yet and must be added with tests:

| Proposed action | Required authority |
|---|---|
| `commerce.identity.link` | Proven Person identity |
| `commerce.listing.create` | Control of selected resource; seller eligibility |
| `commerce.listing.update` | Control of stored resource binding |
| `commerce.listing.publish` | Same, plus approved passport/publication state |
| `commerce.listing.withdraw` | Control of stored binding |
| `commerce.offer.publish` | Control of service; valid design-use rights |
| `commerce.quote.accept` | Proven buyer matching quote/customer binding |
| `commerce.order.record` | Authorized event actor and operation-scoped order facts |
| `commerce.delegation.grant` | Authority to grant the exact requested operation |

A PDP allow remains necessary but not sufficient. The local PEP also enforces:

- customer ownership;
- quote ownership;
- seller/order relationships;
- field restrictions;
- immutable bindings;
- valid commerce state transitions.

### 7.3 New commerce writes must use a bound signed envelope

Do not perpetuate the current replay limitations in a new money-facing integration.

Proposed envelope:

```json
{
  "version": 1,
  "audience": "interfacer-commerce:<instance>",
  "action": "commerce.listing.create",
  "object": { "type": "economic_resource", "id": "<resource-id>" },
  "nonce": "<at-least-128-random-bits>",
  "timestamp": "<RFC3339>",
  "body": {
    "passport_id": "<dpp-id>",
    "expected_source_hash": "<hash>"
  }
}
```

Requirements:

- Serialize once and sign the exact bytes transmitted.
- Handler fixes the expected action.
- Signed object must match the route and resolved operation.
- For updates, load the parent from the stored mapping.
- For creation, validate the signed selected resource, then persist its immutable binding.
- Enforce audience, timestamp window, and nonce uniqueness.
- Bind idempotency keys to the same operation digest.
- Reject unknown envelope versions.
- Use the existing Zenroom signing implementation; do not substitute an incompatible generic Ed25519 format.

Extend PDP transport validation for commerce actions to check that the signed envelope agrees with the requested action and resource binding. The current signature re-verification alone does not establish that correspondence.

### 7.4 Fail-closed behavior

| Failure | Required result |
|---|---|
| Missing/invalid signature or unresolved identity | Reject |
| Unknown action | Reject |
| PDP timeout, malformed response, or deny | No protected side effect |
| Unknown or unenforceable obligation | Reject |
| Changed parent binding | Reject |
| Expired quote or changed source revision | Requote/reapprove |
| Revoked permission | Block new protected execution |
| Ambiguous ledger submission result | Reconcile by receipt key; never blindly recreate |

Record policy version, permission epoch, operation digest, and correlation ID.

An online PDP allow is not a distributed transaction. Zenflows must reauthorize ledger mutations inside its own transaction.

### 7.5 Asynchronous work and delegation

A subscriber has a service identity, not the seller’s authority.

It must not:

- pretend to be the seller;
- store the seller’s private key;
- reuse an unrelated signature indefinitely;
- invoke unchecked Zenflows execution;
- receive blanket administrator authority.

Use two stages:

**Initial implementation:** The subscriber prepares a pending reconciliation command. The seller signs the exact completion command interactively. The worker can then relay that command within its validity rules.

**Unattended implementation:** Introduce explicitly scoped delegation, independently verified by Zenflows. It must constrain:

```text
delegator
delegate service identity
order/line/milestone
resource or deterministic output scope
permitted actions
recipient
maximum quantity
expiry
revocation reference / epoch
operation-template digest
```

Delegation support is new work in both the PDP and command execution boundary. Adding a `delegation` JSON field to today’s request does not implement it.

Service authentication—such as mTLS or a signed service assertion—authenticates the bridge. It does not replace the user’s authorization.

### 7.6 Medusa Admin is not an authorization bypass

Medusa administrators may manage commerce-only fields according to their roles.

They must not change:

- Interfacer identity bindings;
- source resource IDs;
- passport bindings;
- design revision provenance;
- ledger receipt IDs;
- integration-owned snapshots.

Enforce this on the server, not just by hiding Admin form fields.

Supplier access should use restricted custom routes. Do not give marketplace suppliers unrestricted Medusa Admin access.

---

## 8. End-to-end flows

### 8.1 Listing creation

```text
Seller       Commerce PEP       Zenflows/PDP       DPP       Medusa
  | signed listing request            |             |          |
  |-------------->|                   |             |          |
  |               | verify envelope   |             |          |
  |               | load resource ---->|            |          |
  |               | fetch passport ----------------->|          |
  |               | verify ProductID / publication   |          |
  |               | decide(action, proof, parent) -->|          |
  |               |<------------ allow/deny          |          |
  |               | persist pending mapping/job     |          |
  |               | create draft product/variant ---------------->|
  |               | persist IDs, hashes, status     |          |
  |<--------------| listing result                  |          |
```

Creation uses a deterministic mapping key and durable job state.

If Medusa creation succeeds but the bridge loses the response, recovery must locate or reconcile the existing projection. Do not assume Medusa’s generic API requests are automatically idempotent.

Publishing is a separate authorized transition after pricing, stock allocation, channel, shipping, and passport checks.

### 8.2 Listing synchronization

For the first release:

- Explicit signed refresh.
- Compare source and passport hashes.
- Update only integration-owned projected fields.
- Leave commerce-owned fields unchanged.
- Suspend rather than silently substitute a missing, archived, or incompatible source.

No verified source event stream was found during exploration. Use explicit refresh and bounded polling initially.

Later automatic refresh needs an approved scoped synchronization authority; a past listing signature is not blanket permission for future writes.

### 8.3 Stock purchase

```text
Buyer          Commerce API         Medusa           Integration worker
  | bind identity  |                   |                    |
  |--------------->|                   |                    |
  | browse product / create cart ------>|                    |
  | validate linked line ------------->|                    |
  |                 | check active mapping, stock, identity |
  |                 | PDP for protected acceptance          |
  | complete checkout ---------------->|                    |
  |                 | reserve/consume commerce allocation  |
  |                 | payment/order lifecycle              |
  |                 |                   | durable signal -->|
  |<---------------- order confirmation|                    |
```

Order placement does not create a delivery event.

A bound buyer identity and immutable order-line mapping are required before an Interfacer-backed order becomes eligible for ledger reconciliation.

Payment provider callbacks must update Medusa through its verified payment integration. A storefront request cannot assert that payment succeeded.

### 8.4 Design → match → build purchase

```text
Buyer        Matching API       Zenflows/index       Supplier        Medusa
  | requirements/config |               |               |              |
  |-------------------->| load revision/capabilities     |              |
  |                     |-------------->|               |              |
  |<--------------------| explained candidates           |              |
  | request quote ----->|                               |              |
  |                     | fixed-price or approval ------>|              |
  |<--------------------| immutable quote                |              |
  | accept quote ------>| validate buyer/revisions/TTL   |              |
  |                     | authorized cart line ------------------------>|
  | checkout ---------------------------------------------------------->|
  |                     |                               | production job|
  |                     |<------------------------------|              |
```

At production time, reload and verify the pinned artifact hashes. A repository’s moving default branch is not a build specification.

If capacity disappears before purchase acceptance, reject or requote. Do not take payment under a knowingly invalid offer.

### 8.5 Commerce completion → ValueFlows event

Define a bridge-domain milestone, independent of Medusa event naming:

> `delivery_confirmed`: evidence establishes that the specified quantity was handed over under terms that transfer both accountability and custody.

For the initial local test, use explicit seller confirmation and a manual fulfillment provider. Whether buyer confirmation is also required is an owner decision.

```text
Medusa        Subscriber       Worker       Seller/PDP       Zenflows
  | lifecycle signal |            |              |              |
  |----------------->|            |              |              |
  |                  | persist inbox job         |              |
  |                  |----------->|              |              |
  |                  |            | reload trusted order state  |
  |                  |            | derive eligible milestone   |
  |                  |            | request exact signature --->|
  |                  |            |<------ proof + PDP allow    |
  |                  |            | record receipt command ---------------->|
  |                  |            |              | verify/authz/lock       |
  |                  |            |              | insert receipt + event  |
  |                  |            |<---------------- event + resource IDs  |
  |                  |            | mark ledger applied         |
```

For unattended execution, replace interactive signing with the scoped delegation described above—not with a fabricated user principal.

---

## 9. ValueFlows event semantics and idempotency

### 9.1 Completion means a real economic fact

| Commerce milestone | Ledger consequence |
|---|---|
| Cart created | None |
| Order placed | Commercial obligation record; no production/delivery event |
| Payment authorized | None by default |
| Payment captured | Financial state; not proof of production or delivery |
| Build actually produced | `produce`, with actual quantity and output resource |
| Design actually used | `cite`, associated with build process |
| Rights and custody transferred together | `transfer` |
| Only rights transferred | `transferAllRights`, if approved semantics require it |
| Only custody transferred | `transferCustody`, if approved semantics require it |
| Service actually delivered | Potential `deliverService`; define semantics separately |
| Refund | Not automatically an inverse physical event |

A payment-related VF event is possible later, but requires an explicit money-resource and settlement model. It is not part of the first integration.

### 9.2 Existing GraphQL event shape

The following illustrates existing fields, not a new Medusa API:

```graphql
mutation RecordDelivery(
  $seller: ID!
  $buyer: ID!
  $source: ID!
  $unit: ID!
  $at: DateTime!
) {
  createEconomicEvent(
    event: {
      action: "transfer"
      provider: $seller
      receiver: $buyer
      resourceInventoriedAs: $source
      resourceQuantity: {
        hasNumericalValue: 1
        hasUnit: $unit
      }
      hasPointInTime: $at
    }
  ) {
    economicEvent {
      id
      toResourceInventoriedAs {
        id
      }
    }
  }
}
```

This alone is **not** a retry-safe integration command.

Before invocation, validate that:

- the source is a physical saleable resource;
- seller accountability and custody match the selected action;
- quantities and units match;
- sufficient stock remains;
- the order-line mapping fixes the buyer and seller;
- the actor satisfies Zenflows event policy.

### 9.3 Required new Zenflows receipt boundary

Add a narrow command boundary, proposed as:

```text
recordCommerceMilestone
```

The implementation may expose it as a GraphQL mutation or an internal REST command; choose one in the feature design. It must not bypass the existing event domain.

Proposed input:

```text
source_instance
order_id
line_item_id
milestone_id
milestone_type
operation_digest
verified order/fulfillment evidence reference
event parameters
user proof or verified scoped delegation
```

Add a receipt table with a uniqueness constraint on:

```text
(source_instance, order_id, line_item_id, milestone_id, event_role)
```

In **one Zenflows transaction**:

1. Verify actor/delegation.
2. Check existing receipt.
3. Reject the same key with a different digest.
4. Reauthorize using current resource/process facts.
5. Enforce quantity and cumulative-delivery limits.
6. Call the existing event-domain transaction primitives.
7. Persist receipt and resulting event/resource IDs atomically.

Identical retries return the previous result. They do not apply quantities twice.

A bridge-side “already processed” flag cannot solve the crash window between a Zenflows commit and a lost HTTP response.

### 9.4 Partial fulfillment and out-of-order signals

Use stable fulfillment/milestone identifiers, not just order IDs.

- Multiple partial deliveries generate distinct receipts.
- Total delivered quantity cannot exceed the purchased/allotted quantity.
- Duplicate messages do not produce duplicate events.
- Production must exist before transferring a newly manufactured output.
- Late payment/fulfillment signals are evaluated against current trusted state.
- A cancellation racing with delivery enters reconciliation if the physical facts are ambiguous.

Initial scope may reject partial fulfillment, but the key structure must not preclude it.

### 9.5 Passport continuity across transfer

The inspected `transfer` implementation can create a new receiver-side EconomicResource. The original DPP remains immutably bound to the source resource.

Therefore:

- Preserve the source passport as provenance.
- Record source resource, destination resource, event, and source passport in a proposed `PassportLineage` mapping.
- Show the customer which passport describes the sold source/batch and which resource represents their received quantity.
- Never silently rewrite `DPP.ProductID`.
- Never infer that buying a resource grants write access to its original passport.

For the first demonstrator, deliver the original passport reference plus ledger lineage; no DPP writes are required.

If the product requires a buyer-owned passport for each received unit, add an explicitly authorized successor-passport workflow. That requires:

- fixing/using PDP authorization on DPP creation;
- recipient authorization or narrowly scoped delegation;
- immutable lineage to the source passport;
- idempotent creation;
- rules for copying declarations versus issuing new attestations.

This is a release decision, not a detail that can be hidden in synchronization.

---

## 10. API and SDK surface

### 10.1 Verified existing interfaces

| Interface | Status |
|---|---|
| Zenflows `POST /authz/decide` | Exists in inspected PDP worktrees |
| Zenflows `createEconomicEvent` | Exists |
| Zenflows `createProcess` | Exists |
| DPP `GET /dpp/:id` | Existing SDK route |
| DPP `GET /dpps?productId=...` | Existing SDK route |
| DPP mutation routes | Exist, with uneven PDP coverage |
| Commerce routes below | Proposed |
| Medusa lifecycle event names | Must verify against pinned version |

### 10.2 Proposed Commerce API

Use `/commerce/v1` as an integration-owned prefix, independent of Medusa’s native APIs.

| Method/path | Purpose |
|---|---|
| `POST /identity/challenges` | Create customer-linking challenge |
| `POST /identity/links` | Bind authenticated customer to proven Person |
| `POST /listings` | Create immutable source mapping and draft projection |
| `POST /listings/:id/refresh` | Approve a new source snapshot |
| `POST /listings/:id/publish` | Publish eligible listing |
| `POST /listings/:id/withdraw` | Stop new purchases |
| `GET /designs/:id/matches` | Return explained matching results |
| `POST /offers` | Publish supplier-approved build offer |
| `POST /quotes` | Create quote for selected offer/configuration |
| `POST /quotes/:id/accept` | Authorize buyer acceptance and validated cart integration |
| `GET /orders/:id/ledger-status` | Read authorized reconciliation status |
| `POST /orders/:id/milestones/:milestone/confirm` | Sign exact production/delivery command |

Every private operation checks both Medusa session ownership and the relevant Interfacer authorization where applicable.

Responses should include stable integration error codes, for example:

```text
identity_unbound
authorization_denied
authorization_unavailable
source_changed
passport_binding_mismatch
quote_expired
capacity_unavailable
ledger_pending
idempotency_conflict
```

Do not expose private controller details in errors.

### 10.3 Proposed SDK additions

Add:

```text
interfacer-client/src/commerce/CommerceClient.ts
interfacer-client/src/commerce/types.ts
```

And extend:

```text
src/config/config.ts
src/client.ts
src/index.ts
```

Suggested methods:

```ts
linkCustomer(...)
createListing(...)
refreshListing(...)
publishListing(...)
findCompatibleServices(...)
createQuote(...)
acceptQuote(...)
getOrderLedgerStatus(...)
confirmMilestone(...)
```

Implementation rules:

- Reuse `signDidRequest`.
- Add a shared envelope builder; do not duplicate signing logic.
- Preserve exact signed bytes.
- Include typed retryability and authorization errors.
- Do not require `x-user-id` as identity proof.
- Never expose Medusa Admin credentials in the SDK.
- Keep ordinary commerce cart operations on Medusa’s supported Store API where possible.

### 10.4 Medusa adapter responsibilities

Use native Medusa capabilities for:

- product/variant lifecycle;
- prices and currencies;
- sales channels;
- carts and checkout;
- payment providers;
- fulfillment and shipping;
- inventory reservations.

Use the custom module for Interfacer relationships and policy-aware orchestration.

Subscribers should normalize verified Medusa lifecycle signals into integration-owned events such as:

```text
commerce.order_observed
commerce.production_confirmed
commerce.delivery_confirmed
commerce.order_cancelled
commerce.refund_observed
```

These are proposed internal names, not claimed Medusa event names.

Prefer in-process subscribers initially. If remote webhooks become necessary:

- authenticate sender;
- verify raw-body signatures;
- enforce timestamp/replay policy;
- deduplicate delivery IDs;
- refetch authoritative order state;
- acknowledge only after durable ingestion.

Do not assume an application subscriber and a database write are automatically atomic. Verify framework guarantees and add reconciliation polling for missed signals.

---

## 11. Consistency, operations, and security

### 11.1 Stock allocation

Zenflows records physical quantities; Medusa controls commerce reservations.

A listing needs an explicit sellable allocation:

```text
physical resource → allocated quantity → Medusa inventory item/location
```

For the first test, allocate one whole unit exclusively to one Medusa instance.

Do not repeatedly reset Medusa inventory to Zenflows on-hand quantity while ignoring reservations. That can oversell.

If other channels can mutate the same resource, production use requires either:

- an authoritative allocation/reservation mechanism coordinated with Zenflows; or
- an enforceable exclusive-channel rule.

### 11.2 Durable orchestration

Use module-owned inbox/outbox/job tables.

Each job records:

```text
correlation_id
operation_key
payload_digest
source_revision
attempt_count
next_attempt_at
last_error_code
status
```

Retry transient transport errors with bounded exponential backoff and jitter.

Do not automatically retry:

- changed payload under the same key;
- invalid source binding;
- revoked authorization;
- unsupported obligations;
- incompatible quote revisions.

Route these to explicit review.

### 11.3 Reconciliation

Provide a read-only reconciliation report and controlled retry actions.

Check for:

- mappings without Medusa products;
- products without valid mappings;
- stale source/passport projections;
- delivered lines without ledger receipts;
- receipts not yet reflected in module state;
- quantity discrepancies;
- missing successor passports where required;
- jobs blocked on authorization.

Recovery never changes the original order identity, event meaning, or idempotency key.

### 11.4 Privacy and publication

- Copy only approved public passport sections.
- Do not copy customer email/address into public resource metadata.
- Keep payment data in Medusa/payment providers.
- Do not log signatures, private keys, raw sensitive payloads, or payment secrets.
- Restrict artifact and attachment fetching to approved destinations.
- Apply size/type limits and SSRF protection.
- Sanitize descriptions and external URLs.
- Scope private order/quote reads to buyer, authorized seller, or explicit operator role.

### 11.5 Observability

Measure:

- PDP latency and denial reasons;
- projection lag;
- quote failures by reason;
- subscriber ingestion lag;
- oldest pending ledger receipt;
- duplicate suppression;
- stock discrepancies;
- reconciliation backlog.

Propagate one correlation ID across:

```text
signed request → PDP decision → listing/quote → order line → receipt → economic event
```

### 11.6 Rollback

Disable new Interfacer-backed purchases through a feature flag while keeping:

- order reads;
- reconciliation;
- already-authorized fulfillment processing;
- audit records.

Do not delete products, orders, passports, or ledger events to “roll back” the integration.

---

## 12. Phased implementation plan

Every phase uses feature branches and draft PRs. Each has an independently executable acceptance test. No phase authorizes deployment or merging into main.

### Phase 0 — Pin the compatibility baseline

**Work**

- Select exact Interfacer worktree commits.
- Pin Medusa v2 version.
- Verify the framework extension points listed in §3.2.
- Record local environment topology and API contracts.
- Prepare test Persons, one controlled physical resource, and one matching DPP.

**Acceptance**

A local contract report identifies what is available, what is proposed, and which features remain blocked. No real payment credentials are required.

### Phase 1 — First spike: authorized resource/passport projection

**Work**

- Add `commerce.listing.create` policy and vectors.
- Implement commerce envelope validation and replay protection.
- Add one custom module mapping.
- Read one EconomicResource and one DPP.
- Validate passport binding.
- Create one Medusa draft product and one variant.
- Persist mapping and source hashes.
- Implement deterministic retry/recovery.

**Acceptance**

- Authorized controller creates one projection.
- Repeat request creates no duplicate.
- Non-controller creates nothing.
- Forged `x-user-id` has no effect.
- Mismatched passport binding is rejected.
- PDP outage creates nothing.
- Unknown obligations fail closed.
- No Zenflows or DPP mutation occurs.

**Excluded**

Storefront work, live prices, payment, builds, automatic background synchronization, and ledger events.

### Phase 2 — Identity-bound, single-resource purchase

**Work**

- Add customer challenge/link flow.
- Publish the approved listing with one fixed price.
- Configure one currency, channel, stock allocation, and manual/test providers.
- Add server-side checkout validation.
- Freeze `OrderLineBinding`.
- Capture commerce signals durably.

**Acceptance**

A bound customer buys one unit locally. An unbound or wrongly linked customer cannot complete an Interfacer-backed checkout. Concurrent purchases cannot consume the same allocated unit.

Payment/order placement produces **no false delivery event**.

### Phase 3 — Close the REA loop with explicit authorization

**Work**

- Add Zenflows receipt table and `recordCommerceMilestone` boundary.
- Compose receipt creation with existing event-domain transaction primitives.
- Implement seller-signed delivery confirmation.
- Record a `transfer`.
- Store resulting event and receiver-resource IDs.
- Expose ledger status and source-passport lineage.

**Acceptance**

One delivered order line results in one transfer with correct parties, quantity, and units.

Test:

- duplicate subscriber signals;
- lost response after Zenflows commit;
- worker restart;
- changed digest under the same key;
- revoked control;
- wrong seller/buyer;
- insufficient quantity;
- PDP outage.

This is the first full stock-sale round trip.

### Phase 4 — Deterministic design/service matching

**Work**

- Define requirements/capabilities schemas.
- Add authorized metadata editing.
- Build a rebuildable index and pure matching engine.
- Return explanations.
- Add a supplier-approved fixed-price BuildOffer.

**Acceptance**

Fixtures cover compatible, incompatible, unknown, unit-conversion, stale-revision, and missing-capacity cases.

A matching result is not purchasable until an approved offer exists.

### Phase 5 — Single-provider build purchase and production trace

**Work**

- Add immutable quotes and checkout validation.
- Create a build Process.
- Record actual design citation and production.
- Bind the produced output to a DPP.
- Record handover through the receipt mechanism.
- Enforce one supplier per order.

**Acceptance**

A buyer selects a design, chooses a compatible service, purchases the build, and receives a trace:

```text
design revision
  → selected service
  → accepted quote
  → order line
  → production process
  → produced resource
  → passport
  → delivery event
```

Changed artifact hashes, expired quotes, and incompatible capabilities block purchase or execution.

### Phase 6 — Scoped automation and operational hardening

**Work**

- Implement reviewed delegation semantics.
- Add service authentication.
- Support unattended milestone recording.
- Add scoped automatic synchronization.
- Resolve required successor-passport behavior.
- Add reconciliation dashboards and recovery tooling.
- Validate cancellation, refund, and partial-fulfillment policies before enabling them.

**Acceptance**

- Revoked/expired delegation cannot execute.
- Wrong order, recipient, quantity, action, or service audience is denied.
- Crash/retry tests produce no duplicate economic effects.
- No user private keys are stored by the bridge.
- Disabled integration stops new purchases without losing reconciliation.

---

## 13. Test strategy

### Contract and policy tests

Extend shared JSON vectors with commerce cases:

- proven controller allowed;
- non-controller denied;
- forged subject denied;
- signed action/path mismatch;
- parent substitution;
- cross-audience replay;
- expired/repeated nonce;
- unresolved key;
- unenforceable obligations;
- unknown action;
- delegation scope mismatch.

Use the same vectors for the TypeScript PEP and Elixir PDP where applicable.

### Mapping tests

- Distinct Person/customer IDs.
- Distinct resource/passport/DPP-resource IDs.
- Multiple variants without mapping collisions.
- Immutable parent bindings.
- Private DPP fields excluded.
- Catalog quantity not mistaken for physical stock.

### Workflow tests

- Projection crash after remote creation.
- Checkout with stale source or quote.
- Concurrent stock consumption.
- Payment failure.
- Fulfillment before subscriber processing.
- Duplicate and out-of-order signals.
- Receipt commit followed by lost response.
- Production followed by failed DPP creation.
- Transfer resulting in a new destination resource.

### Live local integration tests

Use:

- pinned Zenflows with authorization enforcement enabled;
- real signature verification, not only stubs;
- DPP with test MongoDB;
- Medusa with test Postgres;
- manual/test payment and fulfillment;
- isolated test keys.

A unit test with an injected verifier is not proof of end-to-end cryptographic compatibility.

No test execution was performed as part of this read-only specification.

---

## 14. Risks, limitations, and owner decisions

### 14.1 Required product decisions

| Question | Recommended initial position |
|---|---|
| Who is merchant of record? | One platform merchant; suppliers fulfill |
| Who may sell a resource? | Proven controller plus explicit seller eligibility |
| Does controller equal legal owner? | No assumption; require seller attestation |
| Are guest purchases allowed? | Not for the first integration |
| What makes an order economically complete? | Actual handover, not checkout or capture |
| Must the buyer confirm delivery? | Decide before enabling automatic transfer |
| Are builds paid upfront, by deposit, or by milestone? | Fixed-price test flow first; commercial policy unresolved |
| Is escrow required? | Out of scope until provider/legal design exists |
| Who owns materials and unfinished output? | Must be stated in each build contract |
| Who handles fulfillment and warranty? | One named supplier per order |
| Are designers paid royalties? | No implicit royalty; explicit license/payment policy needed |
| Is a successor passport required for each buyer unit? | Decide before production release |
| Can multiple suppliers fulfill one build? | Defer |
| Are mixed-supplier carts allowed? | Reject initially |
| What happens on return/refund? | Separate physical-return and financial-refund facts |
| Can a supplier substitute material or design revision? | Only through explicit revised quote and buyer consent |

### 14.2 Technical risks

**Authorization is branch-dependent.**  
Integration tests must use compatible feature heads. “Present in a worktree” is not “available in production.”

**Delegation is not implemented.**  
Fully unattended ledger writes require new, reviewed authorization support.

**Medusa is not automatically a marketplace.**  
Supplier isolation, payouts, commissions, disputes, and split settlement are additional product capabilities.

**Physical inventory is not catalog metadata.**  
Interfacer project creation commonly uses quantity one; blindly treating this as stock would be incorrect.

**Cross-system transactions do not exist.**  
Use durable orchestration and idempotent destination receipts, not optimistic assumptions about exactly-once delivery.

**DPP control does not automatically follow transfer.**  
The destination-resource behavior and immutable passport binding require explicit lineage and possibly successor passports.

**Current matching metadata is insufficient.**  
Technical requirements and capabilities must be collected and validated; tags alone cannot safely promise manufacturability.

**Current transport does not enforce the entire documented contract.**  
New commerce actions need signed-operation binding and replay defense from their first implementation.

**External truth remains external.**  
A valid seller signature proves who asserted production/delivery, not that a physical event objectively happened. Evidence, acceptance, and dispute policy remain product responsibilities.

### 14.3 Explicit non-goals for the first integration

- Replacing Zenflows identity with Medusa identity.
- Replacing the DPP service with Medusa metadata.
- Treating wallet points as currency.
- Multi-provider manufacturing orchestration.
- Automatic escrow or split payouts.
- Arbitrary parameterized manufacturing quotes.
- Full bidirectional data replication.
- Automatically exposing currently unavailable commitment/fulfillment GraphQL APIs.
- Rewriting the existing GUI commerce preview wholesale.
- Deployment or changes to main.

---

## 15. First spike

### Authorized EconomicResource + DPP → Medusa draft product

An implementer can start tomorrow with this bounded task:

1. Create feature branches from the agreed PDP/SDK baselines and open draft PRs.
2. Pin a local Medusa v2 version and verify its product-creation extension point.
3. Prepare one registered seller, one controlled physical resource, and one DPP whose `ProductID` matches it.
4. Add the proposed `commerce.listing.create` action, signed-envelope validation, and denial vectors.
5. Implement one signed endpoint that reads those records and creates one draft product/variant.
6. Persist the immutable mapping and hashes.
7. Demonstrate:
   - successful authorized projection;
   - duplicate suppression;
   - foreign-controller denial;
   - passport mismatch denial;
   - fail-closed PDP outage.

**Done means:** a real local Medusa product references the correct Interfacer resource and passport, with demonstrably enforced authorization and repeat-safe creation.

**Why first:** it proves the integration boundary without charging money, moving ownership, inventing manufacturing capability, or requiring a new delegation system.

---

## 16. First-spike decisions (answered by the assistant, 2026-10-21)

Owner delegated these to the assistant. Positions taken for the first spike
(authorized EconomicResource + DPP → one Medusa draft product); each is
revisitable and the Phase 2+ product decisions in §14.1 remain open.

1. **Who may create a listing (`commerce.listing.create`)?** → **Proven resource controller alone** for the first spike. It produces only a *draft* (nothing saleable, no money, no transfer), so the PDP's existing control attestation is sufficient. Explicit *seller eligibility/attestation* is deferred to Phase 2, where publication and sale happen.
2. **Passport in the draft?** → **Reference only.** The draft stores the DPP id and validates the `ProductID` binding; it does **not** copy or expose passport fields. Publication stays an explicit seller-approved action (§3.1.6), out of the spike.
3. **Medusa technical baseline?** → **Adopt §3.1 as-is**: Medusa v2 pinned, supported modules/workflows/extension points only (no core-table writes), single app, and the §3.2 version-verification gate as Phase 0 (verify the real product-creation extension point before coding — do not assume API/event names).
4. **Where does the mapping live?** → **The Interfacer Commerce integration module** owns the immutable `ListingBinding` + source hashes. Zenflows and DPP stay authoritative for their own data; the bridge owns only the cross-reference.
