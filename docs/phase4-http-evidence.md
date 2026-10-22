# P4 — captured HTTP evidence

Selected **verbatim real curl commands/stdout** from the successful cold-DB
`npm run test:p4`, database `interfacer_medusa_p4_acceptance`, Medusa 2.10.3,
2026-10-22 UTC. These are synthetic local data, not external manufacturing facts.
The last request ran against the fixture-disabled server. No response is mocked
or abbreviated. Original full transcript: `.tmp/p4-cold-transcript.md`.

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' http://127.0.0.1:9000/dev/interfacer/designs
```

```text
{"designs":[{"id":"ifdes_p4_organizer","name":"PETG organizer — synthetic design","origin_dpp_id":"dpp-p4-origin-demo","requirements":{"process":["fdm_3d_print"],"materials":["PETG"],"max_dimensions_mm":{"x":120,"y":80,"z":60},"tolerance_mm":0.3,"quantity":2}},{"id":"ifdes_p4_panel","name":"Large PLA panel — synthetic design","origin_dpp_id":null,"requirements":{"process":["fdm_3d_print"],"materials":["PLA"],"max_dimensions_mm":{"x":300,"y":200,"z":10},"tolerance_mm":0.15,"quantity":1}}]}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' http://127.0.0.1:9000/dev/interfacer/services
```

```text
{"services":[{"id":"ifsvc_p4_abs","name":"ABS only — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["fdm_3d_print"],"materials":["ABS"],"build_volume_mm":{"x":220,"y":220,"z":250},"min_tolerance_mm":0.2},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},{"id":"ifsvc_p4_coarse","name":"Coarse FDM — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":220,"y":220,"z":250},"min_tolerance_mm":0.5},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},{"id":"ifsvc_p4_large","name":"Large precise FDM — synthetic service","provider_person_id":"p4-demo-provider-large","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":400,"y":400,"z":400},"min_tolerance_mm":0.1},"base_price_eur":20,"per_unit_price_eur":8,"location":{"country_code":"de","city":"Demo Berlin"}},{"id":"ifsvc_p4_laser","name":"Laser only — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["laser_cut"],"materials":["PETG","PLA"],"build_volume_mm":{"x":220,"y":220,"z":250},"min_tolerance_mm":0.2},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},{"id":"ifsvc_p4_small","name":"Small FDM — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":100,"y":100,"z":100},"min_tolerance_mm":0.2},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},{"id":"ifsvc_p4_standard","name":"Standard FDM — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":220,"y":220,"z":250},"min_tolerance_mm":0.2},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}}]}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'Content-Type: application/json' -X POST --data '{"designId": "ifdes_p4_organizer"}' http://127.0.0.1:9000/dev/interfacer/match
```

```text
{"matches":[{"service":{"id":"ifsvc_p4_standard","name":"Standard FDM — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":220,"y":220,"z":250},"min_tolerance_mm":0.2},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},"quote":{"id":"ifquote_01M5GGY29QP9FKFY6TRYK6EM2K","design_id":"ifdes_p4_organizer","service_id":"ifsvc_p4_standard","provider_person_id":"p4-demo-provider-standard","origin_dpp_id":"dpp-p4-origin-demo","currency_code":"eur","quantity":2,"total_price_cents":1900,"quote_hash":"2e12643e6ad3361a70000e311412086d99cf9fa7d381c9ef16b8da67f949f8d4","snapshot":{"version":"interfacer-fixed-build-v1","design":{"id":"ifdes_p4_organizer","name":"PETG organizer — synthetic design","origin_dpp_id":"dpp-p4-origin-demo","requirements":{"process":["fdm_3d_print"],"materials":["PETG"],"max_dimensions_mm":{"x":120,"y":80,"z":60},"tolerance_mm":0.3,"quantity":2}},"service":{"id":"ifsvc_p4_standard","name":"Standard FDM — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":220,"y":220,"z":250},"min_tolerance_mm":0.2},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},"currency_code":"eur","quantity":2,"base_price_cents":1000,"per_unit_price_cents":450,"total_price_cents":1900,"amount_eur":19},"created_at":"2026-10-22T00:42:17.784Z","updated_at":"2026-10-22T00:42:17.784Z","deleted_at":null}},{"service":{"id":"ifsvc_p4_large","name":"Large precise FDM — synthetic service","provider_person_id":"p4-demo-provider-large","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":400,"y":400,"z":400},"min_tolerance_mm":0.1},"base_price_eur":20,"per_unit_price_eur":8,"location":{"country_code":"de","city":"Demo Berlin"}},"quote":{"id":"ifquote_01M5GGY29XAC61KX4EZMQ0YHP5","design_id":"ifdes_p4_organizer","service_id":"ifsvc_p4_large","provider_person_id":"p4-demo-provider-large","origin_dpp_id":"dpp-p4-origin-demo","currency_code":"eur","quantity":2,"total_price_cents":3600,"quote_hash":"73fe95f1811fdc094317bb501d0d23aa52cabf7ae220c62dfb4b060034f624db","snapshot":{"version":"interfacer-fixed-build-v1","design":{"id":"ifdes_p4_organizer","name":"PETG organizer — synthetic design","origin_dpp_id":"dpp-p4-origin-demo","requirements":{"process":["fdm_3d_print"],"materials":["PETG"],"max_dimensions_mm":{"x":120,"y":80,"z":60},"tolerance_mm":0.3,"quantity":2}},"service":{"id":"ifsvc_p4_large","name":"Large precise FDM — synthetic service","provider_person_id":"p4-demo-provider-large","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":400,"y":400,"z":400},"min_tolerance_mm":0.1},"base_price_eur":20,"per_unit_price_eur":8,"location":{"country_code":"de","city":"Demo Berlin"}},"currency_code":"eur","quantity":2,"base_price_cents":2000,"per_unit_price_cents":800,"total_price_cents":3600,"amount_eur":36},"created_at":"2026-10-22T00:42:17.790Z","updated_at":"2026-10-22T00:42:17.790Z","deleted_at":null}}],"rejected":[{"service":{"id":"ifsvc_p4_abs","name":"ABS only — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["fdm_3d_print"],"materials":["ABS"],"build_volume_mm":{"x":220,"y":220,"z":250},"min_tolerance_mm":0.2},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},"reason":"missing_material: PETG"},{"service":{"id":"ifsvc_p4_coarse","name":"Coarse FDM — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":220,"y":220,"z":250},"min_tolerance_mm":0.5},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},"reason":"tolerance: service 0.5mm > required 0.3mm"},{"service":{"id":"ifsvc_p4_laser","name":"Laser only — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["laser_cut"],"materials":["PETG","PLA"],"build_volume_mm":{"x":220,"y":220,"z":250},"min_tolerance_mm":0.2},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},"reason":"wrong_process: missing fdm_3d_print"},{"service":{"id":"ifsvc_p4_small","name":"Small FDM — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":100,"y":100,"z":100},"min_tolerance_mm":0.2},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},"reason":"too_big: x requires 120mm > 100mm"}]}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'Content-Type: application/json' -X POST --data '{"designId": "ifdes_p4_panel"}' http://127.0.0.1:9000/dev/interfacer/match
```

```text
{"matches":[{"service":{"id":"ifsvc_p4_large","name":"Large precise FDM — synthetic service","provider_person_id":"p4-demo-provider-large","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":400,"y":400,"z":400},"min_tolerance_mm":0.1},"base_price_eur":20,"per_unit_price_eur":8,"location":{"country_code":"de","city":"Demo Berlin"}},"quote":{"id":"ifquote_01M5GGY2B9XHSQ3BTFBYWY6C5H","design_id":"ifdes_p4_panel","service_id":"ifsvc_p4_large","provider_person_id":"p4-demo-provider-large","origin_dpp_id":null,"currency_code":"eur","quantity":1,"total_price_cents":2800,"quote_hash":"41d9781b544589a16cda37e35c9e234fd46905bbec89f885e1c82482a7d5d86d","snapshot":{"version":"interfacer-fixed-build-v1","design":{"id":"ifdes_p4_panel","name":"Large PLA panel — synthetic design","origin_dpp_id":null,"requirements":{"process":["fdm_3d_print"],"materials":["PLA"],"max_dimensions_mm":{"x":300,"y":200,"z":10},"tolerance_mm":0.15,"quantity":1}},"service":{"id":"ifsvc_p4_large","name":"Large precise FDM — synthetic service","provider_person_id":"p4-demo-provider-large","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":400,"y":400,"z":400},"min_tolerance_mm":0.1},"base_price_eur":20,"per_unit_price_eur":8,"location":{"country_code":"de","city":"Demo Berlin"}},"currency_code":"eur","quantity":1,"base_price_cents":2000,"per_unit_price_cents":800,"total_price_cents":2800,"amount_eur":28},"created_at":"2026-10-22T00:42:17.834Z","updated_at":"2026-10-22T00:42:17.834Z","deleted_at":null}}],"rejected":[{"service":{"id":"ifsvc_p4_abs","name":"ABS only — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["fdm_3d_print"],"materials":["ABS"],"build_volume_mm":{"x":220,"y":220,"z":250},"min_tolerance_mm":0.2},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},"reason":"missing_material: PLA; too_big: x requires 300mm > 220mm; tolerance: service 0.2mm > required 0.15mm"},{"service":{"id":"ifsvc_p4_coarse","name":"Coarse FDM — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":220,"y":220,"z":250},"min_tolerance_mm":0.5},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},"reason":"too_big: x requires 300mm > 220mm; tolerance: service 0.5mm > required 0.15mm"},{"service":{"id":"ifsvc_p4_laser","name":"Laser only — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["laser_cut"],"materials":["PETG","PLA"],"build_volume_mm":{"x":220,"y":220,"z":250},"min_tolerance_mm":0.2},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},"reason":"wrong_process: missing fdm_3d_print; too_big: x requires 300mm > 220mm; tolerance: service 0.2mm > required 0.15mm"},{"service":{"id":"ifsvc_p4_small","name":"Small FDM — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":100,"y":100,"z":100},"min_tolerance_mm":0.2},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},"reason":"too_big: x requires 300mm > 100mm; too_big: y requires 200mm > 100mm; tolerance: service 0.2mm > required 0.15mm"},{"service":{"id":"ifsvc_p4_standard","name":"Standard FDM — synthetic service","provider_person_id":"p4-demo-provider-standard","capabilities":{"processes":["fdm_3d_print"],"materials":["PETG","PLA"],"build_volume_mm":{"x":220,"y":220,"z":250},"min_tolerance_mm":0.2},"base_price_eur":10,"per_unit_price_eur":4.5,"location":{"country_code":"de","city":"Demo Berlin"}},"reason":"too_big: x requires 300mm > 220mm; tolerance: service 0.2mm > required 0.15mm"}]}
HTTP 200
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -H 'Content-Type: application/json' -X POST --data '{"designId": "missing-p4-design"}' http://127.0.0.1:9000/dev/interfacer/match
```

```text
{"type":"not_found","message":"design_not_found"}
HTTP 404
```

```bash
curl --silent --show-error --max-time 45 --write-out '
HTTP %{http_code}
' -X POST http://127.0.0.1:9000/dev/interfacer/match
```

```text
{"reason":"local_fixture_mode_required"}
HTTP 403
```
