# Marketplace pilot: operator runbook

For whoever looks after the pilot marketplace (Medusa + its Postgres, next to
Interfacer's Zenflows and GUI). Deployment itself is in
[deploy-pilot.md](deploy-pilot.md). Commands use the dpp-dev layout: one
compose project per directory (`/interfacer-medusa`, `/zenflows`,
`/interfacer-gui`, `/interfacer-gateway-20000`); run them on the host.

Pilot scope: sellers and makers are Persons, payments are test payments
(`pp_system_default`, nothing is charged), the buyer and seller sign every step
with their own Interfacer keys.

## 1. What the moving parts are

```
buyer ─▶ GUI ─▶ Medusa (orders, payments, receipts, outbox) ─▶ Zenflows (economic events)
              ╰▶ inbox (notifications, via the gateway)
```

- **Medusa is the commerce record**: carts, orders, test payments, and for each
  fulfilled order a receipt plus one **outbox row** (`interfacer_zenflows_sync`).
- **Zenflows is the ledger of record** for what moved: the outbox row turns a
  milestone (the seller marks the unit delivered / the build produced) into a
  Process (builds only), a raise/produce, and a transfer to the buyer.
- Every Zenflows write carries `interfacer-sync=<marker>` in its note, so an
  ambiguous write is found again (reconciled) instead of being sent twice.
- With Zenflows authz enforced, each write is signed by the **seller** in their
  browser (My sales → the milestone button). The server never signs for them.
- Notifications go through the Interfacer inbox: the buyer's checkout tells the
  seller "new order"; the seller's milestone tells the buyer "built/delivered".
  They are best-effort: a lost notice never blocks an order.

## 2. Daily check (2 minutes)

```sh
cd /interfacer-medusa
docker compose ps                                   # medusa and db healthy
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9100/health   # 200
docker compose exec -T medusa interfacer-medusa exec ./src/scripts/zenflows-sync-report.js 2>/dev/null \
  | grep -E '^(blocked|pending)|^\{"order_id'
```

The report prints `blocked: N`, `pending: N`, then one JSON line per row that
is not done, oldest first. Healthy: `blocked: 0` and no pending row older than
a day. A one-line summary straight from Postgres:

```sh
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  select status, count(*), max(now() - created_at) as oldest
  from interfacer_zenflows_sync where status <> '\''done'\'' group by status"'
```

Also keep an eye on the host: `df -h / && df -i /` (the root filesystem once ran
out of **inodes**, which silently stopped Watchtower and MongoDB).

## 3. Reading an outbox row

| Field | Meaning |
|---|---|
| `order_id` | Medusa order (also visible to buyer and seller in the GUI). |
| `marker` | `ifzs-…`: search it in Zenflows notes (section 5). |
| `status` | `pending` (still moving), `done`, `blocked` (needs a person). |
| `process_id`, `resource_id`, `creation_event_id`, `transfer_event_id` | Zenflows ids written so far. A row is done when the transfer exists. |
| `inflight_step` | A write was sent and its outcome is not known yet. The row waits 60 s, then looks for it by marker before sending anything again. |
| `attempts`, `next_attempt_at` | Backoff: 5 s doubling, capped at 10 min. |
| `last_error` | Why it is not done. See below. |

## 4. Pending rows

A scheduled job (`interfacer-zenflows-sync`, every minute) advances due rows.
The buyer or the seller can also press retry on the order. Decide by `last_error`:

| `last_error` | What it means | What to do |
|---|---|---|
| `awaiting_seller_signature:<step>` | The next Zenflows write needs the seller's signature (normal with enforced authz). | The seller opens **Selling** and presses the button on that sale. They got a "new order" notification when it was bought; if they missed it, tell them directly. |
| `null`, with `inflight_step` set | Waiting for a write's outcome (≤ 60 s). | Nothing. |
| network / HTTP 5xx / timeout text | Zenflows unreachable or slow. | Check `/zenflows` (`docker compose ps`, `logs web`). Rows recover alone once Zenflows answers. |
| GraphQL error text (e.g. `authz deny …`) | Zenflows refused the write; nothing was written. | Read it: usually the signer is not the provider, or the resource changed owner. Fix the cause, then retry from the order page. |
| `zenflows_product_spec_required` | The Zenflows instance has no "Product" resource specification. | Seed the specs on Zenflows (the GUI's `useResourceSpecs` set), then retry. |
| `zenflows_process_scan_exhausted` | Too many processes created since the write to find it. | Developer task: raise `MAX_PROCESS_PAGES` or reconcile by hand. |

Never edit `payload`, `payload_hash` or `marker`: the row would block as
tampered, and the marker is the only link to what Zenflows already has.

## 5. Blocked rows

A blocked row is never retried automatically: something does not add up and a
person must decide. There is no operator UI yet (release bead 4ku.8), so
resolving is a developer action. Collect, then open a Beads issue with:

1. The row: `docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select * from interfacer_zenflows_sync where order_id = '\''<order>'\''"'`.
2. What Zenflows has for the marker (admin key from `docker inspect zenflows-web-1`
   → `ADMIN_KEY`, never print it):

   ```sh
   curl -s https://zenflows.<host>/api -H 'content-type: application/json' -H "zenflows-admin: $ADMIN_KEY" \
     -d '{"query":"{ economicResources(first: 20, filter: {note: \"interfacer-sync=<marker>\"}) { edges { node { id name note primaryAccountable { id name } previous { id note action { id } provider { id } receiver { id } resourceQuantity { hasNumericalValue } } } } } }"}'
   ```

| `last_error` | Cause | Usual resolution |
|---|---|---|
| `zenflows_reconcile_duplicate` | Two Zenflows objects carry this marker: a write landed twice (e.g. two processes racing). | Keep the one whose provider/receiver/quantity match the order; the other is an orphan to note in the issue. The developer points the row at the kept ids and completes it. |
| `zenflows_reconcile_mismatch` | Zenflows has the marker but provider, receiver, quantity or process differ from the order. | Do not overwrite Zenflows. Find out who wrote it (event provider). If it is wrong, it needs a correcting economic event, decided with the seller. |
| `zenflows_sync_payload_tampered` | The row's payload no longer matches its hash: someone edited the database. | Treat as an incident: compare with the last backup, find who edited it. |
| `zenflows_sync_target_changed` | Medusa now points at a different Zenflows than when the order was fulfilled. | Usually a configuration change (`INTERFACER_ZENFLOWS_URL`). Put the old target back, or accept the order stays unrecorded on the new one. |

Tell the buyer and the seller: their order page shows "on hold" meanwhile.

## 6. Backups and restore

Medusa rows reference Zenflows ids: back up **both databases together**.

```sh
mkdir -p /root/backups && d=$(date +%F-%H%M)
(cd /interfacer-medusa && docker compose exec -T db sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"') > /root/backups/medusa-$d.dump
(cd /zenflows && docker compose exec -T db sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"') > /root/backups/zenflows-$d.dump
ls -l /root/backups/*-$d.dump      # both non-empty
```

Do it before every deploy, migration or test run against the pilot. There is
no scheduled backup on dpp-dev; add a root cron line if the pilot holds real
participants' data for more than a few days.

Restore (stops writes while it runs):

```sh
cd /interfacer-medusa && docker compose stop medusa
docker compose exec -T db sh -c 'pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < /root/backups/medusa-<d>.dump
cd /zenflows && docker compose stop web
docker compose exec -T db sh -c 'pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < /root/backups/zenflows-<d>.dump
docker compose start web && cd /interfacer-medusa && docker compose start medusa
```

People keep their keys in their browsers; nothing else to restore. Orders paid
after the backup are gone: tell those buyers and sellers.

## 7. Common incidents

| Symptom | Check | Fix |
|---|---|---|
| GUI says the marketplace is offline (`market_upstream_unreachable`) | `cd /interfacer-medusa && docker compose ps`, `logs --tail 100 medusa` | `docker compose up -d`. Medusa refuses to boot on incomplete pilot config: the log names the missing variable. |
| People must sign in again to the marketplace | Medusa restarted (login challenges are in memory). | Expected. |
| Sellers say they got no notification | `docker ps` shows `interfacer-gateway-20000-inbox-1`; its logs. | Notices are best-effort and the gateway answers 200 even on errors: ask the seller to check Selling, then fix the inbox. |
| Many pending rows, all with network errors | Zenflows (`/zenflows`: `web`, `pgbouncer`, `db`, `zvmlet`). | Restore Zenflows; rows catch up within minutes. |
| Medusa image not updated after a push to `staging` | The GHCR package is private, so Watchtower cannot pull it; the container opts out of Watchtower. | Rebuild on the host from the `staging` branch (deploy-pilot.md) and `docker compose up -d`. |

## 8. Before onboarding real participants

- [ ] Fresh backup of both databases (section 6).
- [ ] Daily check clean (section 2).
- [ ] Each participant signed up on the GUI and can open **Selling**.
- [ ] A test stock sale and a test build completed end to end, with the buyer
      notified and the order page showing the Interfacer record.
