import { randomBytes } from "node:crypto"

// Local single-process dev authentication only. Challenges disappear on restart;
// there is deliberately no reusable client assertion or chosen verification key.
export class BuyerChallenges {
  private readonly pending = new Map<string, { person: string; expires: number }>()
  constructor(private readonly now = Date.now, private readonly ttl = 60_000, private readonly capacity = 1000) {}

  issue(person: string): string {
    const now = this.now()
    for (const [key, value] of this.pending) if (value.expires <= now) this.pending.delete(key)
    if (this.pending.size >= this.capacity) throw new Error("buyer_challenge_capacity")
    const challenge = randomBytes(32).toString("hex")
    this.pending.set(challenge, { person, expires: now + this.ttl })
    return challenge
  }

  consume(challenge: string, person: string): void {
    const value = this.pending.get(challenge)
    if (!value || value.person !== person || value.expires <= this.now()) throw new Error("buyer_challenge_invalid")
    // Consume synchronously BEFORE awaiting registry/network work: concurrent
    // submissions cannot both redeem the challenge, including a forged attempt.
    this.pending.delete(challenge)
  }
}

export const buyerChallenges = new BuyerChallenges()
