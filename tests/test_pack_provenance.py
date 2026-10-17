import hashlib
from pathlib import Path
import unittest


class OfficialSkillIntegrity(unittest.TestCase):
    def test_official_notion_trees_are_unchanged(self):
        expected = {
            "notion-knowledge-capture": "caec7b33b83a133b19ad16b5d297e118ecdd5a9ecf4c484add18cbc18a694f1e",
            "notion-meeting-intelligence": "817f775ba2b707a76e9a7b862cd1c01fc78a340a06864c3c8c7b2c8d7eff4f7e",
            "notion-research-documentation": "1eea4234bd9de7ecd836bca3a01c9aeb0e929f02571ff323a5964c490fe55ffb",
            "notion-spec-to-implementation": "721905e116db44e5a5475993513fbed5ea4f0bb63fa181f1eb13fe090d182f70",
        }
        root = Path(__file__).parents[1] / "packs/notion/skills"
        for name, digest in expected.items():
            with self.subTest(name=name):
                directory = root / name
                payload = b"".join(path.relative_to(directory).as_posix().encode() + b"\0" + path.read_bytes() + b"\0"
                                   for path in sorted(directory.rglob("*")) if path.is_file())
                self.assertEqual(hashlib.sha256(payload).hexdigest(), digest)
