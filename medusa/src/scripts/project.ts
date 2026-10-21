import type { ExecArgs } from "@medusajs/framework/types"
import { projectResource } from "../modules/interfacer/project-resource"
import { fixtureControllerCheck } from "../modules/interfacer/fixture-controller-check"
import { fixtures } from "./fixtures"

export default async function project({ container }: ExecArgs) {
  const { resource, passport } = fixtures()
  const result = await projectResource(container, resource, passport,
    fixtureControllerCheck(process.env.INTERFACER_FIXTURE_PERSON || ""))
  console.log(JSON.stringify(result, null, 2))
}
