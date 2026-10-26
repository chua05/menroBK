"""Read-only polygon diagnostics. Geometry validity does not certify legal boundaries.

Requires shapely and pyproj. All areas use WGS84 / UTM zone 51N (EPSG:32651).
No input geometry or database record is ever changed.
"""
import argparse
import hashlib
import unicodedata
import json
import math
import re
import zipfile
from collections import Counter
from pathlib import Path

from pyproj import Transformer
from shapely import make_valid, transform as transform_geometry
from shapely.geometry import Point, Polygon, shape
from shapely.ops import unary_union
from shapely.validation import explain_validity

PROJECT = Transformer.from_crs(4326, 32651, always_xy=True).transform


def project(geometry):
    return transform_geometry(geometry, PROJECT, interleaved=False)


def name_of(feature):
    p = feature.get("properties") or {}
    return next((str(p[k]) for k in ("brgy_name", "mpdo_name", "NAME_3", "ADM4_EN", "adm4_en", "name") if p.get(k)), "")


def normalized(name):
    key = re.sub(r"[^a-z0-9ñ]", "", unicodedata.normalize("NFC", name).casefold())
    # Explicit display-name abbreviation, not a persisted identifier migration.
    return key + "lacion" if re.fullmatch(r"zone[ivx]+pob", key) else key


def load(path):
    if str(path).endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            item = next(n for n in z.namelist() if n.endswith((".json", ".geojson")))
            data = json.loads(z.read(item))
        data["features"] = [f for f in data["features"] if f.get("properties", {}).get("NAME_1") == "Sorsogon" and f.get("properties", {}).get("NAME_2") == "Bulan"]
        return data
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def audit(data, reference_names=None):
    structural = []
    if data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
        return {"structuralErrors": ["Expected GeoJSON FeatureCollection"]}
    features = data["features"]
    names = [name_of(f) for f in features]
    rows, geoms, projected = [], [], []
    for index, feature in enumerate(features):
        raw = feature.get("geometry") or {}
        props = feature.get("properties") or {}
        errors, vertices, duplicate_vertices, unclosed = [], 0, 0, 0
        kind = raw.get("type")
        polygons = [raw.get("coordinates", [])] if kind == "Polygon" else raw.get("coordinates", []) if kind == "MultiPolygon" else []
        if feature.get("type") != "Feature" or not polygons:
            errors.append("Missing Feature or unexpected/empty polygon geometry")
        holes = 0
        for polygon in polygons:
            holes += max(0, len(polygon) - 1)
            for ring in polygon:
                if len(ring) < 4:
                    errors.append("Ring has fewer than four positions")
                if not ring or ring[0] != ring[-1]:
                    unclosed += 1
                vertices += len(ring)
                duplicate_vertices += sum(a == b for a, b in zip(ring, ring[1:]))
                for coordinate in ring:
                    if len(coordinate) < 2 or not all(isinstance(v, (float, int)) and math.isfinite(v) for v in coordinate[:2]):
                        errors.append("Non-finite or malformed position")
                    elif not (-180 <= coordinate[0] <= 180 and -90 <= coordinate[1] <= 90):
                        errors.append("Invalid longitude/latitude or reversed coordinates")
        try:
            geometry = shape(raw)
            reason = explain_validity(geometry)
            # make_valid is used in memory ONLY so invalid inputs can still be compared.
            measured = project(geometry if geometry.is_valid else make_valid(geometry)) if not errors else Polygon()
        except Exception as error:
            structural.append({"index": index, "error": str(error)})
            geometry, measured, reason = Polygon(), Polygon(), str(error)
        geoms.append(geometry)
        projected.append(measured)
        rows.append({"name": names[index], "identifier": props.get("GID_3") or props.get("ADM4_PCODE") or props.get("adm4_psgc"),
                     "geometryType": kind, "valid": geometry.is_valid and not geometry.is_empty and not errors and not unclosed,
                     "validityReason": reason, "structureErrors": sorted(set(errors)), "unclosedRings": unclosed,
                     "consecutiveDuplicateVertices": duplicate_vertices, "vertices": vertices,
                     "polygonParts": len(polygons), "holes": holes, "bounds": list(geometry.bounds) if not geometry.is_empty else [],
                     "areaKm2": round(measured.area / 1e6, 8), "overlaps": []})
    overlaps = []
    for i, first in enumerate(projected):
        for j in range(i + 1, len(projected)):
            second = projected[j]
            if not first.intersects(second):
                continue
            area = first.intersection(second).area
            if area > 0.01:
                item = {"first": names[i], "second": names[j], "areaM2": round(area, 4)}
                overlaps.append(item)
                rows[i]["overlaps"].append({"name": names[j], "areaM2": item["areaM2"]})
                rows[j]["overlaps"].append({"name": names[i], "areaM2": item["areaM2"]})
    union = unary_union(projected)
    parts = list(union.geoms) if union.geom_type == "MultiPolygon" else [union]
    gaps = []
    for part in parts:
        if not hasattr(part, "interiors"):
            continue
        for ring in part.interiors:
            gap = Polygon(ring)
            if gap.area > 0.01:
                touching = [names[i] for i, g in enumerate(projected) if g.distance(gap) < 0.01]
                gaps.append({"areaM2": round(gap.area, 4), "neighboringBarangays": touching,
                             "projectedBounds": list(gap.bounds)})
    counts = Counter(normalized(name) for name in names)
    ids = Counter(str(r["identifier"]) for r in rows)
    return {"featureCount": len(features), "geometryTypes": dict(Counter(r["geometryType"] for r in rows)),
            "duplicateNames": [n for n, c in counts.items() if c > 1],
            "duplicateIdentifiers": [n for n, c in ids.items() if c > 1],
            "missingNames": [r["identifier"] for r in rows if not r["name"]],
            "missingIdentifiers": [r["name"] for r in rows if r["identifier"] is None],
            "missingReferenceNames": sorted(set(reference_names or []) - set(names)),
            "unexpectedNames": sorted(set(names) - set(reference_names or names)),
            "structuralErrors": structural, "invalidCount": sum(not r["valid"] for r in rows),
            "sumAreaKm2": round(sum(g.area for g in projected) / 1e6, 8),
            "unionAreaKm2": round(union.area / 1e6, 8),
            "overcountAreaKm2": round((sum(g.area for g in projected) - union.area) / 1e6, 8),
            "unionParts": len(parts), "overlaps": overlaps, "enclosedGapCandidates": gaps,
            "municipalBoundaryCheck": "NOT VERIFIED: no certified independent municipal polygon supplied",
            "rows": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset")
    parser.add_argument("--compare", action="append", default=[])
    parser.add_argument("--reference-js")
    parser.add_argument("--sites", help="Local JSON array or {sites: [...]} export; never connects to Firebase")
    args = parser.parse_args()
    reference = None
    if args.reference_js:
        text = Path(args.reference_js).read_text(encoding="utf-8")
        block = text.split("export const BULAN_BARANGAYS = [", 1)[1].split("];", 1)[0]
        reference = re.findall(r'"([^"]+)"', block)
    canonical = load(args.dataset)
    report = {"limitations": "Geometry diagnostics are not official LGU/MPDO boundary verification. Enclosed union holes are gap candidates, not proven omissions; invalid geometry is repaired only in memory for measurements.",
              "areaCRS": "EPSG:32651", "overlapThresholdM2": 0.01,
              "sha256": hashlib.sha256(Path(args.dataset).read_bytes()).hexdigest(),
              "canonical": audit(canonical, reference), "comparisons": [], "siteDiagnostics": []}
    original = {normalized(name_of(f)): f for f in canonical["features"]}
    for path in args.compare:
        compared = load(path)
        changes = []
        for feature in compared["features"]:
            key = normalized(name_of(feature))
            current = original.get(key)
            if current:
                left, right = shape(current["geometry"]), shape(feature["geometry"])
                safe_left, safe_right = make_valid(left), make_valid(right)
                delta = project(safe_left.symmetric_difference(safe_right)).area
                changes.append({"canonicalName": name_of(current), "comparisonName": name_of(feature),
                                "identicalCoordinates": current["geometry"] == feature["geometry"],
                                "symmetricDifferenceM2": round(delta, 4)})
        report["comparisons"].append({"path": str(path), "audit": audit(compared), "changes": changes,
                                              "unmatchedCanonicalNames": [name_of(f) for f in canonical["features"] if normalized(name_of(f)) not in {normalized(name_of(c)) for c in compared["features"]}],
                                              "unmatchedComparisonNames": [name_of(f) for f in compared["features"] if normalized(name_of(f)) not in original]})
    if args.sites:
        sites = json.loads(Path(args.sites).read_text(encoding="utf-8-sig"))
        for site in sites if isinstance(sites, list) else sites["sites"]:
            lat, lng = site.get("latitude"), site.get("longitude")
            valid = isinstance(lat, (float, int)) and isinstance(lng, (float, int)) and math.isfinite(lat) and math.isfinite(lng)
            matches = [name_of(f) for f in canonical["features"] if valid and make_valid(shape(f["geometry"])).covers(Point(lng, lat))]
            kind = "invalid_coordinates" if not valid else "outside_dataset" if not matches else "ambiguous_overlap_or_shared_edge" if len(matches) > 1 else "match" if normalized(matches[0]) == normalized(site.get("barangay", "")) else "barangay_mismatch"
            report["siteDiagnostics"].append({"siteId": site.get("siteId") or site.get("id"), "storedBarangay": site.get("barangay"), "latitude": lat, "longitude": lng, "containingPolygons": matches, "type": kind,
                                               "action": "Confirm original GPS and LGU/MPDO boundary; do not reassign automatically" if kind != "match" else "No geometric mismatch detected; not official verification"})
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
