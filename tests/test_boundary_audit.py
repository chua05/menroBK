"""Offline diagnostics regression tests. No Firebase imports or database access."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("boundary_audit", ROOT / "scripts/audit-barangay-boundaries.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


def feature(name, ring, identifier=None):
    return {"type": "Feature", "properties": {"brgy_name": name, "GID_3": identifier or name},
            "geometry": {"type": "Polygon", "coordinates": [ring]}}


def square(name, x, y, width=0.01):
    return feature(name, [[x, y], [x + width, y], [x + width, y + width], [x, y + width], [x, y]])


def audit(*features):
    return tool.audit({"type": "FeatureCollection", "features": list(features)})


class BoundaryAuditTests(unittest.TestCase):
    def test_all_63_canonical_features_and_names(self):
        data = tool.load(ROOT / "src/data/bulan-barangays.json")
        result = tool.audit(data)
        self.assertEqual(result["featureCount"], 63)
        for key in ("invalidCount", "overcountAreaKm2"):
            self.assertEqual(result[key], 0)
        for key in ("overlaps", "enclosedGapCandidates", "duplicateNames", "duplicateIdentifiers", "missingNames", "structuralErrors"):
            self.assertEqual(result[key], [])
        self.assertTrue(all(not row["unclosedRings"] and not row["consecutiveDuplicateVertices"] for row in result["rows"]))

    def test_self_intersection_is_reported_not_rewritten(self):
        crossed = feature("crossed", [[123, 12], [123.01, 12.01], [123, 12.01], [123.01, 12], [123, 12]])
        before = json.dumps(crossed)
        self.assertEqual(audit(crossed)["invalidCount"], 1)
        self.assertEqual(json.dumps(crossed), before)

    def test_duplicate_name_and_id(self):
        result = audit(square("same", 123, 12), square("same", 124, 12))
        self.assertEqual(result["duplicateNames"], ["same"])
        self.assertEqual(result["duplicateIdentifiers"], ["same"])

    def test_positive_area_overlap(self):
        self.assertEqual(len(audit(square("a", 123, 12), square("b", 123.005, 12))["overlaps"]), 1)

    def test_shared_edge_is_not_positive_area_overlap(self):
        self.assertEqual(audit(square("a", 123, 12), square("b", 123.01, 12))["overlaps"], [])

    def test_enclosed_hole_is_only_gap_candidate(self):
        f = square("ring", 123, 12, 0.03)
        f["geometry"]["coordinates"].append([[123.01, 12.01], [123.01, 12.02], [123.02, 12.02], [123.02, 12.01], [123.01, 12.01]])
        result = audit(f)
        self.assertEqual(len(result["enclosedGapCandidates"]), 1)
        self.assertIn("NOT VERIFIED", result["municipalBoundaryCheck"])

    def test_unclosed_and_duplicate_vertices(self):
        f = feature("open", [[123, 12], [123.01, 12], [123.01, 12], [123.01, 12.01], [123, 12.01]])
        row = audit(f)["rows"][0]
        self.assertEqual(row["unclosedRings"], 1)
        self.assertEqual(row["consecutiveDuplicateVertices"], 1)

    def test_reversed_coordinates(self):
        f = feature("reversed", [[12, 123], [12, 123.01], [12.01, 123.01], [12, 123]])
        # Structural checks run independently of geometric validity.
        self.assertTrue(any("longitude/latitude" in error for error in audit(f)["rows"][0]["structureErrors"]))


if __name__ == "__main__":
    unittest.main()
