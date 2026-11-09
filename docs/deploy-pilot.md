# Deploying the marketplace pilot

The marketplace is Medusa (this repository's `medusa/` app with the Interfacer
commerce module) plus its own Postgres. It is not a public service: browsers
only ever talk to the GUI, whose `/api/market` route forwards an allowlisted
set of paths to Medusa over a private Docker network. No extra gateway or
microservice is involved.

```
browser ──https──▶ GUI (/api/market proxy) ──http + shared key──▶ Medusa ──▶ Postgres
                                                                   │
                                                                   └──signed GraphQL──▶ Zenflows
```

## What "pilot" mode enforces

`INTERFACER_DEPLOYMENT=pilot` turns the local-only marketplace into a deployable
one. Medusa refuses to start (or migrate) unless the configuration is complete
and free of local switches (`src/modules/interfacer/deployment.ts`):

- `NODE_ENV=production`; no `INTERFACER_AUTH_MODE`, keyring, dev storefront or
  fixture Zenflows mapping.
- Live Zenflows only, with signed writes and the marketplace's own service
  Person (`INTERFACER_ZENFLOWS_SERVICE_USER`/`_SEED`).
- `INTERFACER_PROXY_KEY` (32+ characters): every request must carry it in
  `x-interfacer-proxy-key`. The GUI proxy adds it; nothing else knows it.
- `INTERFACER_COMMERCE_AUDIENCE` (`interfacer-commerce:<instance>`): every
  signed envelope must name it in `aud`, so a signature made for one instance
  is refused by any other. The GUI learns it from `/market/store/config`.
- Every signed envelope is accepted once: its `(person, nonce)` is recorded in
  `interfacer_envelope_nonce` and a replay is refused (`authorization_replayed`).
- `JWT_SECRET` and `COOKIE_SECRET` of 32+ characters.

The marketplace API is served under `/market/*` only. The `/dev/*` aliases,
the dev signer, fixture identities, standalone listings and the demo login
exist only on a local stack. Receipts and sync retries are limited to the
signed-in buyer or seller of each order.

## Image

`ghcr.io/interfacerproject/interfacer-medusa`, built by
`.github/workflows/publish.yml`: `master` → `:latest`, `staging` → `:staging`.
On start the image applies pending migrations, makes sure the commerce context
exists (EUR region for the GUI's shipping countries, sales channel, stock
location, publishable key), then serves on port 9000. Its health check is
`GET /health`.

The admin UI is not built by default (`--build-arg MEDUSA_ADMIN=true` builds
it; `MEDUSA_ADMIN=true` at runtime serves it, to operators over an SSH tunnel).

## First deployment

On the host (paths as on dpp-dev):

1. Shared network, once: `docker network create interfacer-market`.
2. `/interfacer-medusa/`: copy `deploy/docker-compose.yaml`; create `medusa.env`
   and `db.env` from the examples, mode 0600. Generate secrets with
   `openssl rand -hex 32`.
3. The marketplace's service Person on that Zenflows, from a machine with this
   repository and the Zenflows admin key:

   ```sh
   ZENFLOWS_DIRECT=https://<zenflows>/api ZENFLOWS_ADMIN=<admin key> \
   ZENFLOWS_ACTORS=.tmp/<instance>-actors.json ZENFLOWS_ACTOR_NAME="Interfacer marketplace" \
   node scripts/zenflows-actor.cjs create medusa-service
   ```

   Put its `user` and `seed` into `medusa.env`. The seed is a private key:
   keep it only there (and in your password manager).
4. `docker compose up -d` and wait for `docker compose ps` to show healthy.
5. GUI: join the `interfacer-market` network and set
   `MARKET_PROXY_MODE=pilot`, `MEDUSA_INTERNAL_URL=http://medusa:9000`,
   `MEDUSA_PROXY_KEY=<INTERFACER_PROXY_KEY>`, `NEXT_PUBLIC_FF_MARKETPLACE=true`.
   The GUI image builds at container start, so these take effect on restart.

## Operating it

- Logs: `docker compose logs -f medusa`.
- Outbox (Zenflows sync rows that are pending or blocked, oldest first):
  `docker compose exec medusa interfacer-medusa exec ./src/scripts/zenflows-sync-report.js`.
  Pending rows are retried every minute by the scheduled job; a buyer or the
  seller can also retry from the order page. Blocked rows need a person: see
  the row's `last_error` and search Zenflows notes for its `marker`.
- Admin over a tunnel: `ssh -L 9100:127.0.0.1:9100 <host>`, then
  http://localhost:9100/app (image built with the admin), user created with
  `docker compose exec medusa npx medusa user -e <email> -p <password>`.
- Backups: `docker compose exec db pg_dump -U medusa medusa | gzip > medusa-$(date +%F).sql.gz`.
  The ledger of record is Zenflows; Medusa holds carts, orders, payments and
  the bindings between them and Zenflows resources.

## Known limits

- One Medusa process: login challenges are kept in memory, so a restart only
  asks people to sign in again. Two replicas would need shared challenges.
- Test payments only (`pp_system_default`, captured by the buyer's signature).
- Medusa uses its in-memory event bus and Postgres locking (no Redis).
