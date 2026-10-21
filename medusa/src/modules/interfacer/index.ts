import { Module } from "@medusajs/framework/utils"
import InterfacerService from "./service"

export const INTERFACER_MODULE = "interfacer"
export default Module(INTERFACER_MODULE, { service: InterfacerService })
