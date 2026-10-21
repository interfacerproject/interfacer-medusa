# First-spike fixtures

Local stand-ins for a real Interfacer EconomicResource + its Digital Product
Passport, so the spike (resource+DPP → one Medusa draft product/variant) is
testable without a live Zenflows/DPP backend.

**Binding (the invariant the spike validates):** `dpp.productId` ==
`economic-resource.id`. The **controller** authorized to list the resource is
`economic-resource.primaryAccountable.id` (first-spike decision §16.1: proven
controller alone). The passport is **referenced** (its id/URL + attachment
refs), never copied into the product (§16.2).
