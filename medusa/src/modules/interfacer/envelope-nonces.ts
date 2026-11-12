// Replay refusal for signed envelopes: after its signature verifies, an
// envelope's (person, nonce) is recorded once in Postgres; the same envelope
// arriving again is refused, across restarts and processes. Required in pilot;
// a local stack may opt in with INTERFACER_ENVELOPE_NONCES=durable.
import { Pool } from "pg"
import { MedusaError } from "@medusajs/framework/utils"
import { pilotMode } from "./deployment"
import type { SignedOperation } from "./signed-envelope"

export type NonceStore = (personId: string, nonce: string, op: string, issuedAt: string) => Promise<boolean>

export function envelopeNoncesRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return pilotMode(env) || env.INTERFACER_ENVELOPE_NONCES === "durable"
}

let pool: Pool | undefined
let inserts = 0
// true = first use; false = this person already used this nonce.
export const postgresNonceStore: NonceStore = async (personId, nonce, op, issuedAt) => {
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  const { rowCount } = await pool.query(
    `insert into interfacer_envelope_nonce (person_id, nonce, op, issued_at) values ($1, $2, $3, $4)
     on conflict do nothing`, [personId, nonce, op, issuedAt])
  // Anything issued before the acceptance window can never verify again.
  if (++inserts % 200 === 0)
    await pool.query(`delete from interfacer_envelope_nonce where issued_at < now() - interval '15 minutes'`)
  return rowCount === 1
}

export function replayDenied(): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "authorization_replayed")
}

// Call only after the envelope's signature verified. A store outage refuses
// the operation (fail closed) rather than accepting a possible replay.
export async function consumeEnvelopeNonce(auth: unknown, store: NonceStore = postgresNonceStore): Promise<void> {
  if (!envelopeNoncesRequired()) return
  const e = (auth as SignedOperation | undefined)?.envelope
  if (!e) replayDenied()
  let fresh: boolean
  try { fresh = await store(e.person_id, e.nonce, e.op, e.issued_at) }
  catch { throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "authorization_unavailable") }
  if (!fresh) replayDenied()
}
