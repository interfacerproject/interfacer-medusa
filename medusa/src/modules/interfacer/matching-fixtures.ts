// SYNTHETIC local examples, NOT external manufacturing capability/price data.
import type { DesignData, ServiceData } from "./matching"

export const designs: DesignData[] = [
  { id: "ifdes_p4_organizer", name: "PETG organizer — synthetic design", origin_dpp_id: "dpp-p4-origin-demo",
    requirements: { process: ["fdm_3d_print"], materials: ["PETG"],
      max_dimensions_mm: { x: 120, y: 80, z: 60 }, tolerance_mm: 0.3, quantity: 2 } },
  { id: "ifdes_p4_panel", name: "Large PLA panel — synthetic design", origin_dpp_id: null,
    requirements: { process: ["fdm_3d_print"], materials: ["PLA"],
      max_dimensions_mm: { x: 300, y: 200, z: 10 }, tolerance_mm: 0.15, quantity: 1 } },
]
const standard: ServiceData = {
  id: "ifsvc_p4_standard", name: "Standard FDM — synthetic service", provider_person_id: "p4-demo-provider-standard",
  capabilities: { processes: ["fdm_3d_print"], materials: ["PETG", "PLA"],
    build_volume_mm: { x: 220, y: 220, z: 250 }, min_tolerance_mm: 0.2 },
  base_price_eur: 10, per_unit_price_eur: 4.5, location: { country_code: "de", city: "Demo Berlin" },
}
export const services: ServiceData[] = [
  standard,
  { ...standard, id: "ifsvc_p4_large", name: "Large precise FDM — synthetic service",
    provider_person_id: "p4-demo-provider-large", base_price_eur: 20, per_unit_price_eur: 8,
    capabilities: { ...standard.capabilities, build_volume_mm: { x: 400, y: 400, z: 400 }, min_tolerance_mm: 0.1 } },
  { ...standard, id: "ifsvc_p4_laser", name: "Laser only — synthetic service",
    capabilities: { ...standard.capabilities, processes: ["laser_cut"] } },
  { ...standard, id: "ifsvc_p4_small", name: "Small FDM — synthetic service",
    capabilities: { ...standard.capabilities, build_volume_mm: { x: 100, y: 100, z: 100 } } },
  { ...standard, id: "ifsvc_p4_coarse", name: "Coarse FDM — synthetic service",
    capabilities: { ...standard.capabilities, min_tolerance_mm: 0.5 } },
  { ...standard, id: "ifsvc_p4_abs", name: "ABS only — synthetic service",
    capabilities: { ...standard.capabilities, materials: ["ABS"] } },
]
