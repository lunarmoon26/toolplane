import unittest
from bench import Catalog


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.tools = [
            {"id": "a::search", "description": "Search workspace pages"},
            {"id": "b::search", "description": "Search image assets"},
        ]

    def test_exact_qualified_identity(self):
        self.assertEqual(Catalog(self.tools).search("b::search"), ["b::search"])

    def test_visibility_applies_to_exact_lookup_and_ranking(self):
        catalog = Catalog(self.tools, {"a::search"})
        self.assertEqual(catalog.search("image assets"), [])
        self.assertNotIn("b::search", catalog.search("b::search"))
        self.assertEqual(catalog.search("workspace"), ["a::search"])

    def test_empty_and_unknown_are_not_arbitrary_results(self):
        catalog = Catalog(self.tools)
        for query in ("", "   ", "!!!", "unmatched"):
            self.assertEqual(catalog.search(query), [])

    def test_limits(self):
        for limit in (0, 21, True, 1.5):
            with self.assertRaises(ValueError):
                Catalog(self.tools).search("search", limit)

    def test_empty_visibility(self):
        self.assertEqual(Catalog(self.tools, set()).search("search"), [])


if __name__ == "__main__":
    unittest.main()
