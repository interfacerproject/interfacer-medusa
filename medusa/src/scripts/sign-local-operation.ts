// CLI/TEST CLIENT ONLY. Server verification never imports private keys.
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import type { SignedOperation } from "../modules/interfacer/signed-envelope"

export function signLocalOperation(op: string, params: unknown, person: string, keyPerson?: string): SignedOperation {
  return JSON.parse(execFileSync(process.execPath, [resolve(__dirname, "../../../scripts/sign.cjs"),
    op, person, JSON.stringify(params), ...(keyPerson ? [keyPerson] : [])], { encoding: "utf8" }))
}
