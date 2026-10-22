import type { ExecArgs } from "@medusajs/framework/types"
import { projectResource } from "../modules/interfacer/project-resource"
import { signLocalOperation } from "./sign-local-operation"
import { fixtures } from "./fixtures"

export default async function project({ container }: ExecArgs) {
  const { resource, passport } = fixtures()
  const result = await projectResource(container, resource, passport,
    signLocalOperation("commerce.listing.create", { resource, dpp: passport }, process.env.INTERFACER_SIGNING_PERSON || ""))
  console.log(JSON.stringify(result, null, 2))
}
