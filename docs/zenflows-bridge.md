# Zenflows bridge (bridges B/C/D)

How the marketplace writes **live ValueFlows economic events** to a locally-run
Zenflows, and how to take it from the current coarse demo mapping to real
per-entity actors and resources.

## Bridge C — live events (done)

A delivery (`transfer`) and a production (`produce`) milestone write a real
`createEconomicEvent` to Zenflows, alongside the local `rea-receipt`. The event
id is persisted on the receipt (`zenflows_event_id`) and shown in the GUI with a
`LIVE` badge. See `medusa/src/modules/interfacer/zenflows-event.ts`.

### Enable it

Set these before `npm run dev:up` (unset → no-op, the marketplace runs
stand-alone against the local `rea-receipts` sink only):

```bash
export INTERFACER_ZENFLOWS_URL=http://localhost:8000/api
export INTERFACER_ZENFLOWS_PROVIDER=<agent ULID>   # the seller/provider agent
export INTERFACER_ZENFLOWS_RECEIVER=<agent ULID>   # the buyer person
export INTERFACER_ZENFLOWS_RESOURCE=<resource ULID># the resource transferred/produced
export INTERFACER_ZENFLOWS_UNIT=<unit ULID>        # e.g. the "one" unit
# optional: export INTERFACER_ZENFLOWS_ADMIN=<hex>  # only if GQL_AUTH_CALLS=true
```

`dev-store.py` copies `os.environ` into the Medusa process, so exported vars pass
through.

### Getting the ULIDs

Zenflows GraphQL ids are **ULID** (26-char), not the UUID the DB shows. Fetch via
GraphQL against the running local Zenflows:

```bash
curl -s -X POST http://localhost:8000/api -H 'content-type: application/json' \
  -d '{"query":"{ agents(first:5){edges{node{id name}}} economicResources(first:5){edges{node{id name}}} units(first:2){edges{node{id label}}} }"}'
```

The local Zenflows (PR #84) seeds an org (`System Materials Repository`), material
resources (PLA/ABS/PETG/…) and a `one` unit on migrate; a signed-up person (e.g.
`Market Seven`) is a valid receiver. Two local-only flags are required for this to
work: `ROOM_SALT` must be valid base64, and `AUTHZ_ENFORCE=false`
(createPerson/createEconomicEvent are otherwise denied by the PR #84 authz PEP).

## Bridges B/D — per-listing real resource + real agents (done)

Each delivery/production now **raises a real per-listing EconomicResource** (ValueFlows
`raise`, conforming to the seeded `Product` spec, owned by the provider agent, named and
`trackingIdentifier`-tagged to the marketplace catalog resource), then **transfers** that
exact resource to the buyer. So `resourceInventoriedAs` is a real, distinct resource per
listing (bridge B) between real agents — the seller org and the buyer person (bridge D).
Verified: a GUI "Mark delivered" raised resource `06GP97B5ZR…` ("Interfacer listing
01JTESTRESOURCE…") and transferred it (`06GP97B632…`, System Materials Repository →
Market Seven), shown in the GUI with the LIVE badge.

### Remaining

The provider agent, the buyer person and the unit are still **one fixed seeded pair** read
from env (the demo has one seller and one buyer). A true `produce` as the output of a VF
`Process` (with `outputOf`) is a refinement over the current raise+transfer. Per-buyer
identity (receiver = the signed-in Interfacer person of the order) is the next step.

## Legacy note (bridge C, before B/D)

The provider/receiver/resource env vars were a **coarse demo mapping**: every event used the
same fixed Zenflows triple. B/D replaced the resource with a per-listing one; the agents are
still the fixed seeded pair.

- **Bridge B — real match data.** Designs and services (and the catalog's
  resources) come from real Interfacer resources and registered providers, so the
  event's `resourceInventoriedAs` is the actual listed resource. The matching
  algorithm is already real; it needs real inputs.
- **Bridge D — real identity.** Resolve the seller and buyer to their real Zenflows
  agents (the buyer being the signed-in Interfacer person), so `provider` and
  `receiver` are the actual parties, not a fixed pair.

### Proposed path

1. At marketplace setup, ensure/seed the real Zenflows entities (a provider org, a
   resource per catalog product, the buyer person) and record their ULIDs where the
   listing binding and the buyer identity are stored, rather than in four fixed env
   vars.
2. Make `writeZenflowsEvent` take the provider/receiver/resource **per order**,
   resolved from the binding + identity, instead of the fixed config.
3. The adapter and the receipt plumbing already carry the event id end-to-end; only
   the resolution of the three ids changes.
