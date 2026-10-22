import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Resource } from "../modules/interfacer/signed-envelope"
import type { Passport } from "../modules/interfacer/project-resource"

export function fixtures(): { resource: Resource; passport: Passport } {
  // CLI only, fixed repo-local fixture paths; no user-supplied remote URLs.
  const dir = resolve(process.cwd(), "../docs/fixtures")
  return {
    resource: JSON.parse(readFileSync(resolve(dir, "economic-resource.json"), "utf8")),
    passport: JSON.parse(readFileSync(resolve(dir, "dpp.json"), "utf8")),
  }
}
