# Bulan barangay boundary audit — 20 October 2026

## Verdict and scope

Technical map-layer fixes are implemented. Geographic accuracy remains UNVERIFIED; no polygon, stored coordinate, barangay assignment, production record, API contract, or business rule was changed.

Audited runtime-file SHA-256 (unchanged): `43dfac5cea0d1755741d03462d40cfc1ff83beef57bbb5a10388c20a973dbdce`.

The read-only phase inspected both repositories, the active boundary file, extraction scripts, all Leaflet consumers, local reference names, a downloaded comparison file, and the available downloaded GADM archive. No Firebase records were read. The reported N. Roque site's actual ID/GPS/export was not supplied, so its individual geographic root cause is NOT VERIFIED.

## Current architecture

- Canonical runtime dataset: backend `src/data/bulan-barangays.json`.
- `src/config/municipality.js` derives BARANGAYS/BARANGAY_SET from it.
- `src/controller/site.controller.js:getBarangayBoundaries` serves the same object at public `GET /api/sites/barangay-boundaries` (`src/routes/site.routes.js`).
- Backend `src/utils/geo.util.js` handles Polygon/MultiPolygon, exterior rings and holes, converting GeoJSON [longitude, latitude] correctly. Site service validates municipal-union containment, not a selected barangay's containment. Selected barangay and GPS are independent stored values.
- Frontend uses Leaflet 1.9.x. `src/utils/userTypes.js:BULAN_BARANGAYS` duplicates the 63 names, but not polygon coordinates. It matches the active file exactly.
- Boundary consumers: SitesPage (main/Add/Edit/details), DashboardPage (role dashboards), MapVisualizationPage, ParticipantSaplingRequestWizard, MyRequestsPage, SeedlingRequestsPage, PlantingPage and AnalyticsSitesMap (used by ReforestationAnalyticsPage). All use the same backend endpoint, not independent geographic datasets.
- MonitoringPage's evidence preview renders the saved site polygon and photo GPS, not a separate barangay dataset. GuestEventPage similarly shows event/site/photo positions without an administrative dataset. EventSchedulePage does not define another Leaflet boundary layer. No new administrative overlays were added to these already-working previews.
- Seedling Request's proposed-site coverage validation has its own ray-casting implementation and selected-barangay checks. Axis ordering is correct. No automatic GPS-to-barangay reassignment was found. Its existing coverage/approval restrictions were not changed.
- Site service currently filters returned sites to the dataset's municipal union. Therefore a site missing from the UI is not proof that its saved record was deleted or invalid. This existing rule was not changed.
- `scripts/audit-juban-sites.js` can connect to Firebase and delete records; it was deliberately NOT executed.

## Provenance and authority

`scripts/extract-bulan-geojson.js` identifies GADM 4.1 as the source and selects Sorsogon/Bulan. The current data retains GADM GID_3 identifiers, NOT PSGC identifiers. The locally available GADM archive is not bit-identical to the runtime extraction: **56 of 63 geometries differ at the coordinate-array level**. Seven coordinate arrays match exactly; some other differences have nearly zero area (vertex ordering/segmentation can differ without a displaced footprint). The repository does not establish an authoritative explanation for all modifications.

A separate generator expects missing `src/data/barangays.geojson` and would output a different source file. Its “authoritativeSource” string is not evidence of LGU certification. Neither extraction script was executed.

PSA's [Bulan PSGC page](https://psa.gov.ph/classification/psgc/barangays/0506203000) lists 63 barangays, municipality code 0506203000, correspondence code 056203000. Project names correspond after spacing/punctuation and Zone *Pob.* / *Poblacion* display-alias reconciliation. This confirms the list/count, NOT polygon locations. GADM GIDs must not be substituted for PSGC codes.

GADM is not an LGU cadastral certification. Its [license](https://gadm.org/license.html) also requires checking permitted use/redistribution before distributing derived boundary assets. No LGU/MPDO-certified or independently certified NAMRIA municipal polygon was available. Municipality containment, shoreline accuracy, legal boundary alignment, actual label-to-polygon assignment, and positional displacement against official control data remain NOT VERIFIED.

The downloaded `bgysubmuns-municity-506203000.0.1.json` has 63 features with PSGC-style attributes, but those attributes alone do not authenticate its provenance. It is an offline comparison only, NOT a proposed automatic replacement. Leading-zero numeric identifiers must not be confused with GADM GIDs or blindly migrated.

## Municipality-wide results

Areas use WGS84 / UTM zone 51N (EPSG:32651), with 0.01 m² positive-area intersection/gap threshold. They are polygon measurements, not official land-area statistics. Gap checks detect enclosed holes in the union; they cannot prove missing coastline areas, boundary-connected gaps, or legal coverage. No inferred municipal hull was used as an official boundary. Projection/linear-segment effects and the threshold should be considered when interpreting tiny slivers.

| Dataset | Features | Invalid geometries | Positive overlap pairs | Enclosed gap candidates | Union km² |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current runtime file | 63 | 0 | 0 | 0 | 187.39501701 |
| Downloaded comparison | 63 | 0 | 0 | 0 | 199.75235319 |
| Downloaded original GADM Bulan subset | 63 | 0 | 50 | 34 | 186.37085302 |

Current file: 63 MultiPolygons, unique names and GIDs, no missing project reference names, no malformed longitude/latitude positions, unclosed rings, or consecutive duplicate vertices. All ring/part structures are valid. The union has two connected parts; Libertad contains two polygon parts. This is not by itself an error or proof of an island's legal affiliation. Several polygons are very coarse (five/six positions including closure); sparsity is a positional-accuracy risk, not invalid geometry.

The candidate's union is 12.35733618 km² larger (about 6.59%). Every matched candidate geometry differs from the current geometry. All 63 can be matched by explicit formatting aliases including the eight Zone Pob. names. These substantial differences require source confirmation municipality-wide, not a visual choice between maps.

The original GADM subset has total overlap overcount 0.91620131 km². The current file is topologically cleaner by these measures, but this does not prove that past editing preserved correct administrative locations. No automatic repair or replacement is justified.

## All 63 barangays inspected

Every row below passed current schema/ring/geometry/unique-name checks, with **zero current overlaps and enclosed-gap candidates**. Areas are measured, not certified. Δ is symmetric-difference area in m² versus the respective downloaded dataset; zero rounded to two decimals does not establish identical coordinate arrays. Every barangay still requires authoritative geographic verification.

| Barangay (persisted spelling) | GADM ID | Area km² | Vertices incl. closure | Parts | Δ original GADM m² | Δ candidate m² |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| A.Bonifacio | PHL.69.2.1_1 | 2.393926 | 12 | 1 | 6939.09 | 2097624.61 |
| AbadSantos | PHL.69.2.2_1 | 2.994958 | 7 | 1 | 0.00 | 3060523.34 |
| Aguinaldo | PHL.69.2.3_1 | 1.079273 | 6 | 1 | 0.00 | 4654391.63 |
| Antipolo | PHL.69.2.4_1 | 1.149469 | 9 | 1 | 57528.07 | 1754507.22 |
| Beguin | PHL.69.2.5_1 | 4.376181 | 30 | 1 | 93415.73 | 2350921.06 |
| BenignoS.Aquino | PHL.69.2.6_1 | 2.427126 | 6 | 1 | 114935.12 | 4070443.39 |
| Bical | PHL.69.2.7_1 | 5.273585 | 9 | 1 | 12577.73 | 3657762.97 |
| Bonga | PHL.69.2.8_1 | 2.911460 | 8 | 1 | 2.78 | 4690755.52 |
| Butag | PHL.69.2.9_1 | 4.934549 | 12 | 1 | 8.18 | 2185221.59 |
| Cadandanan | PHL.69.2.10_1 | 3.087690 | 8 | 1 | 1581.07 | 5297322.55 |
| Calomagon | PHL.69.2.11_1 | 2.741950 | 12 | 1 | 31444.05 | 4737112.61 |
| Calpi | PHL.69.2.12_1 | 3.342710 | 10 | 1 | 4534.16 | 3144404.68 |
| Cocok-Cabitan | PHL.69.2.13_1 | 2.380623 | 8 | 1 | 1463.22 | 4604096.20 |
| Daganas | PHL.69.2.14_1 | 3.913728 | 9 | 1 | 0.00 | 8579513.79 |
| Danao | PHL.69.2.15_1 | 2.579400 | 7 | 1 | 0.22 | 1452598.50 |
| Dolos | PHL.69.2.16_1 | 3.353038 | 8 | 1 | 0.00 | 5232004.46 |
| E.Quirino | PHL.69.2.17_1 | 1.337775 | 6 | 1 | 0.00 | 2065511.37 |
| Fabrica | PHL.69.2.18_1 | 2.736743 | 11 | 1 | 721.39 | 3287994.23 |
| G.DelPilar | PHL.69.2.19_1 | 1.423612 | 12 | 1 | 143133.29 | 2235554.21 |
| Gate | PHL.69.2.20_1 | 6.476292 | 8 | 1 | 43693.83 | 4443715.82 |
| Inararan | PHL.69.2.21_1 | 4.952375 | 13 | 1 | 94751.60 | 4178142.96 |
| J.Gerona | PHL.69.2.22_1 | 3.195847 | 11 | 1 | 35328.47 | 6628478.33 |
| J.P.Laurel | PHL.69.2.23_1 | 0.968945 | 8 | 1 | 378.51 | 1864858.10 |
| Jamorawon | PHL.69.2.24_1 | 4.115223 | 12 | 1 | 39806.13 | 2496935.10 |
| Lajong | PHL.69.2.25_1 | 4.541981 | 17 | 1 | 219054.68 | 4182027.37 |
| Libertad | PHL.69.2.26_1 | 0.251699 | 12 | 2 | 57135.40 | 229766.21 |
| M.Roxas | PHL.69.2.27_1 | 2.442827 | 7 | 1 | 0.02 | 3122871.06 |
| Magsaysay | PHL.69.2.28_1 | 2.584345 | 9 | 1 | 81766.01 | 3041003.05 |
| Managanaga | PHL.69.2.29_1 | 1.929167 | 11 | 1 | 37004.19 | 2909922.65 |
| Marinab | PHL.69.2.30_1 | 2.523934 | 15 | 1 | 13322.12 | 4365582.04 |
| Montecalvario | PHL.69.2.31_1 | 6.677532 | 11 | 1 | 0.00 | 7180246.03 |
| N.Roque | PHL.69.2.32_1 | 1.629612 | 10 | 1 | 7159.07 | 2514606.83 |
| Namo | PHL.69.2.33_1 | 3.000085 | 6 | 1 | 32369.46 | 2540003.74 |
| Nasuje | PHL.69.2.34_1 | 1.378589 | 10 | 1 | 28423.20 | 2158768.20 |
| Obrero | PHL.69.2.35_1 | 0.495720 | 8 | 1 | 21618.47 | 373359.05 |
| Osme�a | PHL.69.2.36_1 | 1.134539 | 8 | 1 | 0.00 | 2626472.28 |
| Otavi | PHL.69.2.37_1 | 6.061097 | 16 | 1 | 85931.54 | 2917633.25 |
| PadreDiaz | PHL.69.2.38_1 | 8.390417 | 12 | 1 | 24830.33 | 2847991.86 |
| Palale | PHL.69.2.39_1 | 3.196231 | 16 | 1 | 39136.54 | 3685835.02 |
| Quezon | PHL.69.2.40_1 | 2.616119 | 11 | 1 | 10588.93 | 3618454.52 |
| R.Gerona | PHL.69.2.41_1 | 4.420797 | 8 | 1 | 23051.19 | 3541542.25 |
| Recto | PHL.69.2.42_1 | 4.998306 | 16 | 1 | 89110.81 | 6316752.59 |
| Sagrada | PHL.69.2.43_1 | 1.897864 | 10 | 1 | 0.02 | 1936627.01 |
| SanFrancisco | PHL.69.2.44_1 | 7.927418 | 20 | 1 | 114305.82 | 4646140.92 |
| SanIsidro | PHL.69.2.45_1 | 6.996602 | 18 | 1 | 56135.05 | 6589969.57 |
| SanJuanBag-O | PHL.69.2.46_1 | 2.727821 | 12 | 1 | 16332.57 | 2075765.89 |
| SanJuanDaan | PHL.69.2.47_1 | 2.293340 | 10 | 1 | 0.36 | 3494993.22 |
| SanRafael | PHL.69.2.48_1 | 1.868770 | 21 | 2 | 0.06 | 1947921.83 |
| SanRamon | PHL.69.2.49_1 | 1.141572 | 10 | 1 | 0.00 | 2791684.74 |
| SanVicente | PHL.69.2.50_1 | 0.379323 | 19 | 2 | 17002.15 | 992168.82 |
| SantaRemedios | PHL.69.2.51_1 | 1.617768 | 10 | 1 | 1807.01 | 1738931.20 |
| SantaTeresita | PHL.69.2.52_1 | 1.738752 | 8 | 1 | 2.49 | 838995.54 |
| Sigad | PHL.69.2.53_1 | 2.817206 | 9 | 1 | 28423.67 | 2227021.63 |
| Somagongsong | PHL.69.2.54_1 | 3.168596 | 14 | 1 | 69198.18 | 5044416.66 |
| Taromata | PHL.69.2.55_1 | 18.554895 | 18 | 1 | 86386.90 | 19329371.72 |
| ZoneIPoblacion | PHL.69.2.56_1 | 0.037293 | 9 | 1 | 0.40 | 92579.84 |
| ZoneIIPoblacion | PHL.69.2.57_1 | 0.085394 | 5 | 1 | 0.00 | 155467.68 |
| ZoneIIIPoblacion | PHL.69.2.58_1 | 0.435340 | 9 | 1 | 27964.88 | 506510.19 |
| ZoneIVPoblacion | PHL.69.2.59_1 | 0.242664 | 5 | 1 | 0.00 | 281057.31 |
| ZoneVPoblacion | PHL.69.2.60_1 | 0.512077 | 10 | 1 | 32194.92 | 655279.35 |
| ZoneVIPoblacion | PHL.69.2.61_1 | 0.163006 | 9 | 2 | 37957.92 | 221898.44 |
| ZoneVIIPoblacion | PHL.69.2.62_1 | 0.274721 | 9 | 1 | 0.18 | 401631.88 |
| ZoneVIIIPoblacion | PHL.69.2.63_1 | 0.095122 | 5 | 1 | 0.00 | 391289.16 |

## Original-source overlap diagnostics (NOT present in current runtime file)

These 50 pairs are provided to explain source reliability and prior modifications, not as claims of current map overlaps.

| First barangay | Second barangay | Intersection m² |
| --- | --- | ---: |
| A.Bonifacio | Beguin | 18722.10 |
| A.Bonifacio | Lajong | 2453.43 |
| Antipolo | Inararan | 25279.16 |
| Antipolo | Nasuje | 2952.66 |
| Beguin | Lajong | 14805.12 |
| Beguin | SanFrancisco | 5852.05 |
| Beguin | SanJuanDaan | 5573.24 |
| Beguin | Somagongsong | 31830.33 |
| BenignoS.Aquino | Inararan | 67714.06 |
| Bonga | SanIsidro | 16925.68 |
| Bonga | Taromata | 484.34 |
| Butag | SanIsidro | 7612.27 |
| Cadandanan | Calpi | 4529.57 |
| Cadandanan | Cocok-Cabitan | 1580.86 |
| Calomagon | Recto | 16125.56 |
| Calpi | Palale | 582.67 |
| Cocok-Cabitan | Palale | 3.88 |
| Cocok-Cabitan | Recto | 1467.28 |
| Danao | R.Gerona | 16871.04 |
| Fabrica | Sigad | 1119.11 |
| G.DelPilar | Magsaysay | 42288.02 |
| G.DelPilar | SanJuanBag-O | 10480.18 |
| Gate | SantaTeresita | 43691.49 |
| Inararan | J.P.Laurel | 68807.44 |
| Inararan | Managanaga | 25940.58 |
| J.Gerona | Marinab | 35343.79 |
| J.P.Laurel | ZoneVPoblacion | 197.32 |
| J.P.Laurel | ZoneVIIPoblacion | 181.25 |
| Lajong | SanJuanBag-O | 19729.04 |
| Libertad | SanVicente | 24644.77 |
| Libertad | ZoneIPoblacion | 5593.88 |
| M.Roxas | SanFrancisco | 59348.74 |
| Managanaga | SantaRemedios | 1806.18 |
| Managanaga | ZoneVPoblacion | 37001.33 |
| Marinab | Taromata | 4769.37 |
| N.Roque | Otavi | 28857.03 |
| Namo | Nasuje | 32371.50 |
| Obrero | ZoneVIIIPoblacion | 21618.47 |
| Otavi | SanIsidro | 3009.27 |
| Otavi | Sigad | 57072.56 |
| PadreDiaz | SantaTeresita | 9693.30 |
| Palale | Recto | 65053.02 |
| Quezon | Sagrada | 10588.96 |
| R.Gerona | Recto | 6183.47 |
| SanFrancisco | Somagongsong | 1822.05 |
| SanIsidro | Taromata | 25.74 |
| SanRafael | SanVicente | 7931.15 |
| SanVicente | ZoneIPoblacion | 854.81 |
| ZoneVPoblacion | ZoneVIPoblacion | 16739.48 |
| ZoneVPoblacion | ZoneVIIPoblacion | 32196.01 |

## Original-source enclosed gap candidates (NOT present in current runtime file)

These may reflect source topology, legitimate exclusions or water, or projection/segmentation effects; they are not certified omissions.

| Candidate | Neighboring polygons | Area m² |
| --- | --- | ---: |
| 1 | Cocok-Cabitan, Palale, Recto | 6447.81 |
| 2 | Palale, Recto | 2929.35 |
| 3 | Calomagon, E.Quirino, Palale, Recto, SanFrancisco | 15315.18 |
| 4 | BenignoS.Aquino, Calomagon, Inararan, SanFrancisco, Somagongsong | 19821.17 |
| 5 | A.Bonifacio, BenignoS.Aquino, Calomagon, Inararan, Somagongsong | 47213.05 |
| 6 | A.Bonifacio, Beguin, Somagongsong | 6933.12 |
| 7 | SanFrancisco, Somagongsong | 54950.14 |
| 8 | Antipolo, Calomagon, Recto | 17607.45 |
| 9 | A.Bonifacio, Beguin | 21218.30 |
| 10 | Beguin, SanJuanBag-O, SanJuanDaan | 16327.13 |
| 11 | G.DelPilar, Magsaysay, N.Roque | 7160.57 |
| 12 | Magsaysay, N.Roque, PadreDiaz, SanIsidro, SanRamon | 81762.38 |
| 13 | N.Roque, Otavi, SanIsidro, SanRamon | 28527.48 |
| 14 | Gate, Magsaysay, PadreDiaz, SanIsidro, SanRamon, Taromata | 15138.21 |
| 15 | SanIsidro, Taromata | 85873.46 |
| 16 | A.Bonifacio, BenignoS.Aquino, Lajong, Managanaga, SantaRemedios | 46542.12 |
| 17 | Fabrica, Lajong, Obrero, SanVicente, SantaRemedios | 72008.65 |
| 18 | Fabrica, Libertad, Obrero, SanVicente, ZoneVIIIPoblacion | 26896.86 |
| 19 | Fabrica, Lajong | 63643.06 |
| 20 | Fabrica, G.DelPilar, Lajong, N.Roque, Sigad | 90358.89 |
| 21 | Libertad, SanVicente, ZoneIPoblacion | 8216.14 |
| 22 | Managanaga, SantaRemedios, ZoneIIIPoblacion | 21228.70 |
| 23 | Managanaga, ZoneIIIPoblacion, ZoneVPoblacion | 6736.45 |
| 24 | Antipolo, Inararan, Nasuje | 25468.08 |
| 25 | Antipolo, Namo, Nasuje, Recto | 32249.04 |
| 26 | Fabrica, SanRafael, SanVicente | 721.37 |
| 27 | Fabrica, Otavi, SanRafael, Sigad | 27304.53 |
| 28 | Bical, Calpi, M.Roxas, Palale | 35631.31 |
| 29 | Bical, Calpi, M.Roxas, Montecalvario, SanFrancisco | 12577.67 |
| 30 | Beguin, Somagongsong | 6972.45 |
| 31 | Beguin, SanFrancisco, Somagongsong | 15725.47 |
| 32 | Beguin, Jamorawon, SanFrancisco | 56294.29 |
| 33 | Beguin, Jamorawon, SanJuanDaan | 39805.97 |
| 34 | Bonga, J.Gerona, Marinab, Taromata | 8534.97 |

## Site diagnostics and N. Roque / San Ramon

No approved real-site export or authenticated local record evidence was available. **The production mismatch list is NOT VERIFIED, not empty.** No production Firebase access was attempted. Supply a sanitized local array of {id/siteId, barangay, latitude, longitude} for the offline tool; it returns every containing polygon rather than selecting the first overlap match.

One existing synthetic fixture was checked from `tests/integration/seedEmulator.js`, without running its seeder:

| Site ID | Stored barangay | Latitude | Longitude | Containing polygon | Type | Recommended action |
| --- | --- | ---: | ---: | --- | --- | --- |
| phase2-site (synthetic only) | Bical | 12.671 | 123.875 | ZoneIIIPoblacion | barangay_mismatch | Keep fixture untouched; do not use as evidence for real-world geographic accuracy. Review before any future geographic acceptance test. |

N.Roque is valid, 1.62961234 km², bounding box [123.9212,12.6492,123.9327,12.667203559870561]. SanRamon is valid, 1.14157219 km², bounding box [123.9327,12.6578,123.9496,12.6712]. No positive-area overlap between them exists in the current file. N.Roque's footprint differs by 7,159.07 m² from original GADM; SanRamon's rounded difference is zero although coordinate arrays differ. Candidate differences are much larger: 2,514,606.83 m² and 2,791,684.74 m² respectively.

Confirmed technical contributors: manual barangay and municipal-valid GPS can disagree without an existing per-barangay warning; asynchronous polygon layers previously shared the site-overlay pane and could obscure markers/coverage; site details omitted its available boundary prop. No longitude/latitude reversal was found. None of those proves that the screenshot's site belongs in N.Roque or SanRamon. The actual discrepancy requires original site ID/GPS, acquisition accuracy, data provenance, and MPDO boundary verification.

## Safe implementation and exact changed files

Backend (new offline tooling/tests/docs only; no backend runtime changes):

- `scripts/audit-barangay-boundaries.py`: read-only GeoJSON schema/topology/name/ID/area comparison and optional local-site diagnostics. No Firebase import, network operation, or input write. Invalid geometry is repaired IN MEMORY ONLY for diagnostics, never saved.
- `scripts/requirements-geo-audit.txt`: optional isolated Python tooling, not Node/runtime dependencies.
- `tests/test_boundary_audit.py`: eight offline geometry regression tests.
- `tests/barangayBoundary.test.js`: two controller/coordinate regression tests, with site service mocked so Firebase is never initialized.
- `docs/barangay-boundary-audit.md`: this report.

Frontend:

- `src/utils/barangayMap.js`: reusable noninteractive boundary pane at z-index 350 (tiles 200, site overlays 400+); display-only mismatch diagnostics with holes/MultiPolygon/shared-edge ambiguity, safe numeric validation, formatting normalization, and no data mutation.
- `src/pages/SitesPage.jsx`: applies boundary pane to main/modal layers, supplies canonical data to details preview, and adds nonblocking Add/Edit/details warnings. No coordinate selection, radius, submission, or validation rule changed.
- `src/pages/DashboardPage.jsx`
- `src/pages/MapVisualizationPage.jsx`
- `src/pages/MyRequestsPage.jsx`
- `src/pages/ParticipantSaplingRequestWizard.jsx`
- `src/pages/PlantingPage.jsx`
- `src/pages/SeedlingRequestsPage.jsx`
- `src/components/analytics/AnalyticsSitesMap.jsx`
  — the seven files above only import/use the same boundary-pane options. Existing styles, selected highlights, labels, markers and fetch URLs are retained.
- `tests/barangayMap.test.mjs`: five regressions for layering, diagnostic safety, ambiguous shared edges/overlaps, holes/MultiPolygon, and canonical endpoint/pane adoption across all eight renderers.
- Per frontend AGENTS.md, `graphify update .` refreshed existing dirty graphify-out graph/cache files and created a dated backup under `graphify-out/2026-10-20/`. Existing Graphify artifacts were not discarded. The command reported inaccessible old .docx-work scratch folders and an unrelated Swift skill-parser warning; JavaScript extraction completed. These are generated navigation artifacts, not application changes.

No CSS redesign, map library, geographic dataset, production data, or frontend/backend dependency change was introduced. Existing unrelated backend hardening diffs and frontend graph artifacts were preserved.

## Verification results

- Python 3.13 isolated tooling (Shapely 2.2.0 / PyProj 3.8.0): **8/8 PASS**.
- Current full GeoJSON audit and comparison: **63/63 current features valid**; candidate/raw-source metrics above.
- Frontend `node --test --test-isolation=none tests/*.test.js tests/*.test.mjs`: **104/104 PASS**, including five new tests and existing safety tests.
- Targeted ESLint on all nine changed frontend source files: **PASS**.
- Frontend production build: **PASS**; pre-existing large-chunk warning remains. Initial sandbox attempt could not spawn native build processes; permitted rerun succeeded without dependency changes.
- Isolated headless Chromium/Leaflet harness: **15/15 PASS** (1920/1440/1366/768/390 px × three open/remove/reopen cycles). All 63 polygons render below marker/coverage paths even when added later; pointer events do not intercept map clicks; radius/GPS remain unchanged; no horizontal overflow. HTTP requests were blocked and no Firebase session used. This is a component-level Leaflet test, NOT authenticated end-to-end testing of every application modal or real tile/network availability.
- Isolated current backend source/test copy using the previously clean-installed Batch 4 dependency tree: **202/204 PASS**, including both new boundary tests. Two unrelated connectedWorkflow tests fail because their preferred release date is fixed at **2026-10-19**, now in the past. Tests at connectedWorkflow.test.js:124 and :211 were NOT modified. Initial deliberately invalid loopback-port settings were rejected by the safety guard; rerun used normal mock-only unit settings.
- Focused boundary endpoint/coordinate + integration safety tests: **6/6 PASS**.
- Authenticated real-site visual comparison, actual tile loading, real site submission, production/backend HTTP integration, and official municipality containment: **NOT VERIFIED**. No live emulator records were needed or changed for these display-only fixes.
- Both repositories `git diff --check`: **PASS** (line-ending advisories only).

## Reproduce offline

From the backend, use Python 3.13 and a temporary environment; these tools never connect to Firebase:

```powershell
$geoEnv = Join-Path $env:TEMP 'menro-boundary-audit-venv'
py -3.13 -m venv $geoEnv
& "$geoEnv\Scripts\python.exe" -m pip install -r scripts/requirements-geo-audit.txt
& "$geoEnv\Scripts\python.exe" scripts/audit-barangay-boundaries.py src/data/bulan-barangays.json --reference-js ../menrosystem/src/utils/userTypes.js
& "$geoEnv\Scripts\python.exe" tests/test_boundary_audit.py
# Optional approved local export; never pass credentials or service-account files:
& "$geoEnv\Scripts\python.exe" scripts/audit-barangay-boundaries.py src/data/bulan-barangays.json --sites C:/path/to/sanitized-sites.json
```

Use `--compare C:/path/to/candidate.json` (repeatable) for per-barangay differences. GADM ZIP comparison filters only NAME_1=Sorsogon and NAME_2=Bulan. JSON output goes to stdout; do not overwrite an input file. Local site exports may contain sensitive location data: store reports privately, not in Git.

## Remaining authoritative-data work / recommendation

1. Obtain LGU/MPDO-approved, dated barangay polygons AND an independent approved municipal boundary, CRS/datum metadata, source precision, stable identifiers, legal/administrative reference, usage license, and custodial contact. Ask explicitly about N.Roque/SanRamon and prior boundary editing.
2. Have LGU/MPDO reconcile all 63 candidate-vs-current differences, particularly very coarse polygons and the large Taromata difference. Include shared edges, coastal extent, the second Libertad part, and former original-source gap locations. Do not infer legal boundaries from basemap road/label placement.
3. Receive a sanitized authorized site export; diagnose all sites, distinguish invalid GPS, outside-dataset, name mismatch, and multi-polygon ambiguity. Review each discrepancy without automatic reassignment or overwriting historical coordinates.
4. Establish a reviewed GADM-name ↔ current PSGC crosswalk and versioned provenance manifest. Preserve historic GIDs and stored names unless a separate approved migration is designed.
5. Validate replacement topology/coverage and site impacts in isolation; obtain MENRO approval before swapping the one canonical file. Do not switch to the candidate solely because it has cleaner topology or larger coverage.
6. Existing backend municipal-union restrictions and request coverage checks depend on unverified polygons. They remain unchanged to preserve security/workflow rules; an official-data or policy decision is required before relaxing them. The new site warning itself never blocks a submission.
7. Rerun authenticated local modal/preview tests and fix time-sensitive unrelated test fixtures in a separately authorized task.

**Final recommendation:** Keep the runtime GeoJSON unchanged pending authoritative verification. Technical consistency/diagnostic improvements are ready for local review; municipality-wide geographic certification and the original reported real-site mismatch remain unresolved. No commit, push, deployment, scheduler activation, Firebase access, or record migration occurred.
