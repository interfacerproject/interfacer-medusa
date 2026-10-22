# First-spike fixtures

Local stand-ins for a real Interfacer EconomicResource + its Digital Product
Passport, so the spike (resource+DPP → one Medusa draft product/variant) is
testable without a live Zenflows/DPP backend.

**Binding (the invariant the spike validates):** `dpp.ProductID` ==
`economic-resource.id`. The **controller** authorized to list the resource is
`economic-resource.primaryAccountable.id` (first-spike decision §16.1: proven
controller alone). The passport is **referenced by ID only**, never copied into the product (§16.2).

## P6a disposable signing keys

`auth-public-keyring.json` is a LOCAL Person → Ed25519 public-key registry.
`auth-private-keyring.json` contains deliberately PUBLIC, disposable demo private
keys for the CLI/harnesses. Never use these keys in a deployment. The server
verifier reads only the public map. Root scripts and `scripts/sign.cjs` seed
separate `.tmp/auth-{public,private}-keyring.json` files; explicit CLI enrollment
adds unique per-run buyer keys, never through an HTTP endpoint. See
[the real-vs-local auth boundary](../phase6a-findings.md).
