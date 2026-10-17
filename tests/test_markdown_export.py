import importlib.util
import json
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout
from io import StringIO
from types import SimpleNamespace
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "packs/notion/skills/notion-markdown-export/scripts/export_markdown.py"
spec = importlib.util.spec_from_file_location("markdown_export", SCRIPT)
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)

ROOT = "11111111111141118111111111111111"
CHILD = "22222222222242228222222222222222"
OTHER = "33333333333343338333333333333333"


def page(id, title, content="", **extra):
    return {"metadata": {"type": "page"}, "title": title,
            "url": "https://app.notion.com/p/" + id,
            "text": '<page url="https://app.notion.com/p/' + id + '">\n<content>\n' + content + '\n</content>\n</page>', **extra}


class ExportTests(unittest.TestCase):
    def test_cli_export_uses_broker_not_direct_mcporter(self):
        calls = []
        def run(command, **kwargs):
            calls.append(command)
            return SimpleNamespace(stdout=json.dumps({"receiptId": "fixture", "result": {"structuredContent": page(ROOT, "Fixture")}}))
        with tempfile.TemporaryDirectory() as temporary:
            argv = [str(SCRIPT), ROOT, str(Path(temporary) / "out"), "--tool-id", "fixture-source::notion-fetch", "--cache", str(Path(temporary) / "cache")]
            with patch("sys.argv", argv), patch.object(export.subprocess, "run", run), redirect_stdout(StringIO()):
                self.assertEqual(export.main(), 0)
            self.assertEqual(calls[0][:1], ["bun"])
            self.assertEqual(Path(calls[0][1]), Path(__file__).parents[1].resolve() / "src/cli.ts")
            self.assertEqual(calls[0][2:4], ["call", "fixture-source::notion-fetch"])
            self.assertEqual(json.loads(calls[0][4]), {"id": ROOT, "include_transcript": False})

    def test_scope_uuid_normalization_and_blank_pages(self):
        self.assertEqual(export.page_id("11111111-1111-4111-8111-111111111111"), ROOT)
        self.assertEqual(export.page_id("https://app.notion.com/p/Example-" + ROOT + "?pvs=12"), ROOT)
        with self.assertRaises(ValueError):
            export.page_id("https://example.com/" + ROOT)
        text = f'<page url="https://app.notion.com/p/{CHILD}">Child</page>\n'
        text += f'<mention-page url="https://app.notion.com/p/{OTHER}">Mention</mention-page>\n'
        text += f'```xml\n<page url="https://app.notion.com/p/{OTHER}">Example</page>\n```\n'
        text += f'`<page url="https://app.notion.com/p/{OTHER}">Inline example</page>`'
        self.assertEqual(export.children(page(ROOT, "Root", text)), [CHILD])
        blank = page(CHILD, "Blank")
        blank["text"] = f'<page url="https://app.notion.com/p/{CHILD}"><blank-page>This page is blank.</blank-page></page>'
        self.assertEqual(export.children(blank), [])
        self.assertEqual(export.body(blank), "")

    def test_tree_export_links_duplicates_and_readme_title(self):
        root = page(ROOT, "README", f'<page url="https://app.notion.com/p/{CHILD}">Repeated title</page>\n<page url="https://app.notion.com/p/{OTHER}">Repeated title</page>')
        source = {ROOT: root, CHILD: page(CHILD, "同名页面"), OTHER: page(OTHER, "同名页面")}
        with tempfile.TemporaryDirectory() as temporary:
            cache, out = Path(temporary) / "cache", Path(temporary) / "out"
            export.crawl(ROOT, source.__getitem__, cache)
            result = export.render(cache, out)
            self.assertTrue(result["complete"])
            self.assertEqual(result["page_count"], 3)
            self.assertEqual(result["blank_pages"], 2)
            self.assertEqual(result["broken_links"], [])
            paths = [item["file"] for item in result["pages"]]
            self.assertEqual(len(set(paths)), 3)
            self.assertNotIn("README.md", paths)
            self.assertTrue((out / "README.md").is_file())
            self.assertIn("- [Repeated title]", (out / paths[0]).read_text())

    def test_tables_and_fences_are_preserved(self):
        code = '````xml\n```\n<page url="https://app.notion.com/p/' + CHILD + '">Not a child</page>\n````\n'
        text = code + '<table header-row="true"><tr><td>Heading</td></tr><tr><td>a|b</td></tr></table>\n'
        text += '~~~python\nprint("<empty-block/>")\n~~~\n'
        with tempfile.TemporaryDirectory() as temporary:
            cache, out = Path(temporary) / "cache", Path(temporary) / "out"
            export.crawl(ROOT, lambda id: page(id, "Root", text), cache)
            result = export.render(cache, out)
            content = (out / result["pages"][0]["file"]).read_text()
            self.assertIn(code, content)
            self.assertIn('~~~python\nprint("<empty-block/>")\n~~~', content)
            self.assertIn("| Heading |\n| --- |\n| a\\|b |", content)
            self.assertEqual(result["page_count"], 1)
            self.assertTrue(result["complete"])

    def test_partial_export_records_failures_and_remote_links(self):
        root = page(ROOT, "Root", f'<page url="https://app.notion.com/p/{CHILD}">Unavailable</page>\n<folder url="https://app.notion.com/p/{OTHER}">Folder</folder>\n<unknown/>', truncated=True)
        def fetch(id):
            if id != ROOT:
                raise OSError("unavailable")
            return root
        with tempfile.TemporaryDirectory() as temporary:
            cache, out = Path(temporary) / "cache", Path(temporary) / "out"
            export.crawl(ROOT, fetch, cache)
            result = export.render(cache, out)
            self.assertFalse(result["complete"])
            self.assertEqual(result["page_count"], 1)
            self.assertEqual(len(result["failures"]), 1)
            self.assertEqual({item["reason"] for item in result["warnings"]}, {
                "truncated_or_omitted_subtrees", "folder_not_expanded", "unknown_not_expanded",
            })
            self.assertIn("https://app.notion.com/p/" + CHILD, (out / result["pages"][0]["file"]).read_text())

    def test_resume_reuses_cached_pages_and_refetches_failed_children(self):
        calls = []
        def fetch(id):
            calls.append(id)
            if id == CHILD:
                raise OSError("unavailable")
            return page(ROOT, "Root", f'<page url="https://app.notion.com/p/{CHILD}">Child</page>')
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / "cache"
            export.crawl(ROOT, fetch, cache)
            calls.clear()
            def recovered(id):
                calls.append(id)
                return page(id, "Child")
            state = export.crawl(ROOT, recovered, cache, resume=True)
            self.assertEqual(calls, [CHILD])
            self.assertEqual(state["failures"], [])
            before = (cache / "manifest.json").read_bytes()
            with self.assertRaises(ValueError):
                export.crawl(OTHER, recovered, cache, resume=True)
            self.assertEqual((cache / "manifest.json").read_bytes(), before)

    def test_limit_and_existing_destination_never_report_complete_or_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache, out = Path(temporary) / "cache", Path(temporary) / "out"
            export.crawl(ROOT, lambda id: page(id, "Root", f'<page url="https://app.notion.com/p/{CHILD}">Child</page>'), cache, max_pages=1)
            result = export.render(cache, out)
            self.assertFalse(result["complete"])
            self.assertEqual(result["failures"][0]["reason"], "page_limit")
            before = (out / "README.md").read_bytes()
            with self.assertRaises(FileExistsError):
                export.render(cache, out)
            self.assertEqual((out / "README.md").read_bytes(), before)

    def test_mcp_error_and_missing_root_do_not_create_export(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache, out = Path(temporary) / "cache", Path(temporary) / "out"
            export.crawl(ROOT, lambda id: {"isError": True, "content": []}, cache)
            with self.assertRaises(ValueError):
                export.render(cache, out)
            self.assertFalse(out.exists())

    def test_text_and_structured_mcp_envelopes(self):
        payload = page(ROOT, "Root")
        self.assertEqual(export.unwrap({"content": [{"type": "text", "text": json.dumps(payload)}]}), payload)
        self.assertEqual(export.unwrap({"structuredContent": payload}), payload)


if __name__ == "__main__":
    unittest.main()
