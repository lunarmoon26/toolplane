"""Read-only Toolplane page-tree export. No third-party Python dependencies."""

import argparse
import datetime
import html
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import quote, unquote, urlparse


def page_id(value):
    value = value.strip()
    if re.fullmatch(r"[a-fA-F0-9-]{32,36}", value):
        return uuid.UUID(value).hex
    url = urlparse(value)
    host = (url.hostname or "").lower()
    if url.scheme != "https" or not (
        host in {"app.notion.com", "notion.so", "www.notion.so", "notion.com", "www.notion.com"}
        or host.endswith(".notion.site")
    ):
        raise ValueError("Expected a Notion page URL or UUID")
    found = re.search(r"([a-f0-9]{32})(?:/|$)", url.path.replace("-", ""), re.I)
    if not found:
        raise ValueError("Page URL must include its UUID")
    return found[1].lower()


def unwrap(value):
    if not isinstance(value, dict) or value.get("isError"):
        raise ValueError("MCP returned an invalid or error response")
    if isinstance(value.get("structuredContent"), dict):
        return unwrap(value["structuredContent"])
    if isinstance(value.get("text"), str):
        return value
    for block in value.get("content", []):
        if block.get("type") == "text":
            try:
                return unwrap(json.loads(block["text"]))
            except (ValueError, TypeError):
                continue
    raise ValueError("Response has no page text")


def body(page):
    text = page["text"]
    if "<content>" in text and "</content>" in text:
        return text.split("<content>", 1)[1].rsplit("</content>", 1)[0].strip("\n")
    if "<blank-page>" in text:
        return ""
    raise ValueError("Unrecognized Notion page format")


def segments(text):
    """Yield prose/code separately, preserving fenced code including long fences."""
    pending = []
    fence = None
    for line in text.splitlines(keepends=True):
        match = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)", line)
        if fence is None and match:
            yield False, "".join(pending)
            pending = [line]
            fence = match[1]
        elif fence is not None and match and match[1][0] == fence[0] and len(match[1]) >= len(fence) and not match[2].strip():
            pending.append(line)
            yield True, "".join(pending)
            pending = []
            fence = None
        else:
            pending.append(line)
    yield fence is not None, "".join(pending)


def children(page):
    text = "".join(part for code, part in segments(body(page)) if not code)
    text = re.sub(r"(`+).*?\1", "", text)
    return list(dict.fromkeys(page_id(html.unescape(match[1])) for match in re.finditer(
        r'<page\b[^>]*\burl="([^"]+)"[^>]*>', text
    )))


def slug(title):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", title).strip(" .")
    # Bound bytes, not characters: Unicode names must fit filesystem limits too.
    return name.encode("utf-8")[:140].decode("utf-8", errors="ignore") or "Untitled"


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def crawl(root, fetch, cache, resume=False, max_pages=500):
    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=resume, mode=0o700)
    state_path = cache / "manifest.json"
    if resume:
        state = json.loads(state_path.read_text())
        if state["root"] != root:
            raise ValueError("Resume cache belongs to a different root")
    state = {"root": root, "pages": [], "failures": [], "warnings": []}
    write_json(state_path, state)
    queue, seen = [root], {root}
    while queue:
        id = queue.pop(0)
        target = cache / (id + ".json")
        try:
            page = unwrap(json.loads(target.read_text()) if resume and target.is_file() else fetch(id))
            if not isinstance(page.get("title"), str) or not isinstance(page.get("url"), str):
                raise ValueError("Page response is missing title or URL")
            if page.get("metadata", {}).get("type", "page") != "page":
                raise ValueError("Only pages are supported by this exporter")
            owned = children(page)
            write_json(target, page)
            state["pages"].append({"id": id, "children": owned})
            text = body(page)
            if page.get("truncated") or page.get("unknown_block_ids") or page.get("unknown_block_count", 0):
                state["warnings"].append({"id": id, "reason": "truncated_or_omitted_subtrees"})
            prose = "".join(part for code, part in segments(text) if not code)
            for kind in ("database", "folder", "unknown"):
                if re.search(r"<" + kind + r"\b", prose):
                    state["warnings"].append({"id": id, "reason": kind + "_not_expanded"})
            for child in owned:
                if child in seen:
                    continue
                seen.add(child)
                if len(seen) > max_pages:
                    state["failures"].append({"id": child, "reason": "page_limit"})
                    continue
                queue.append(child)
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            # Avoid logging raw server output, signed links or private page content.
            state["failures"].append({"id": id, "reason": type(error).__name__})
        finally:
            write_json(state_path, state)
    return state


def table(match):
    rows = []
    for row in re.findall(r"<tr\b[^>]*>([\s\S]*?)</tr>", match[2]):
        cells = re.findall(r"<td\b[^>]*>([\s\S]*?)</td>", row)
        if cells:
            rows.append([re.sub(r"(?<!\\)\|", r"\\|", cell.strip().replace("\n", "<br>")) for cell in cells])
    if not rows:
        return match[0]
    width = max(map(len, rows))
    rows = [row + [""] * (width - len(row)) for row in rows]
    if 'header-row="true"' not in match[1]:
        rows.insert(0, [""] * width)
    lines = ["| " + " | ".join(row) + " |" for row in rows]
    lines.insert(1, "| " + " | ".join(["---"] * width) + " |")
    return "\n\n" + "\n".join(lines) + "\n\n"


def convert(text, source, paths, pages):
    def relative(id):
        return quote(os.path.relpath(paths[id], paths[source].parent), safe="/.-_~")

    def link(match):
        url, title = html.unescape(match[2]), match[3]
        try:
            target = page_id(url)
        except ValueError:
            target = None
        href = relative(target) if target in paths else url
        title = title or (pages[target]["title"] if target in pages else url)
        title = title.replace("[", r"\[").replace("]", r"\]")
        return f"[{title}]({href})"

    text = re.sub(r'(?m)^([ \t]*)(<page\b[^>]*>.*?</page>)[ \t]*$', r"\1- \2", text)
    text = re.sub(r'<(page|mention-page|mention-database|mention-data-source|database|folder)\b[^>]*url="([^"]+)"[^>]*>([\s\S]*?)</\1>', link, text)
    text = re.sub(r"<table\b([^>]*)>([\s\S]*?)</table>", table, text)
    text = re.sub(r'<link-preview\b[^>]*url="([^"]+)"[^>]*/>', lambda m: f"<{m[1]}>", text)
    text = re.sub(r"<(?:empty-block|table_of_contents)\b[^>]*/>", "", text)
    text = re.sub(r"<span\b[^>]*>([\s\S]*?)</span>", r"\1", text)
    text = re.sub(r'\s*\{(?:color|toggle)="[^"]+"[^}]*\}', "", text)
    text = re.sub(r"<callout\b[^>]*>([\s\S]*?)</callout>", lambda m: "\n" + "\n".join(
        "> " + line.removeprefix("\t") for line in m[1].strip("\n").splitlines()
    ) + "\n", text)
    text = re.sub(r'<(audio|file|embed|pdf|video)\b[^>]*src="([^"]+)"[^>]*>([\s\S]*?)</\1>', lambda m: f"[{m[3] or m[1]}]({m[2]})", text)

    def rewrite(match):
        try:
            target = page_id(match[1])
        except ValueError:
            return match[0]
        return "](" + relative(target) + ")" if target in paths else match[0]

    return re.sub(r"\]\((https://[^)]+)\)", rewrite, text)


def render(cache, destination):
    cache, destination = Path(cache), Path(destination)
    state = json.loads((cache / "manifest.json").read_text())
    pages = {item["id"]: json.loads((cache / (item["id"] + ".json")).read_text()) for item in state["pages"]}
    root = state["root"]
    if root not in pages:
        raise ValueError("Root fetch failed; inspect the private cache manifest")
    paths = {root: Path(slug(pages[root]["title"]) + "--" + root + ".md")}
    parents, queue = {}, [root]
    edges = {item["id"]: item["children"] for item in state["pages"]}
    while queue:
        id = queue.pop(0)
        directory = Path("subpages") if id == root else paths[id].with_suffix("")
        for child in edges[id]:
            if child not in pages or child in paths:
                continue
            paths[child] = directory / (slug(pages[child]["title"]) + "--" + child + ".md")
            parents[child] = id
            queue.append(child)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.mkdir(mode=0o700)  # Exclusive: never overwrite an export or symlink.
    records = []
    for id, page in pages.items():
        raw = body(page)
        content = "".join(part if code else convert(part, id, paths, pages) for code, part in segments(raw))
        header = "\n".join([
            "---", "title: " + json.dumps(page["title"], ensure_ascii=False),
            "source: " + json.dumps(page["url"]), "notion_id: " + json.dumps(id),
            "last_edited: " + json.dumps(page.get("page_last_edited_at")), "---", "", "# " + page["title"], "",
        ])
        if id in parents:
            parent = parents[id]
            href = quote(os.path.relpath(paths[parent], paths[id].parent), safe="/.-_~")
            header += f'\n[↑ {pages[parent]["title"]}]({href})\n\n'
        target = destination / paths[id]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(header + (content if raw.strip() else "*This Notion page is blank.*") + "\n")
        target.chmod(0o600)
        records.append({"id": id, "title": page["title"], "file": str(paths[id]), "source": page["url"], "blank": not bool(raw.strip())})
    index = ["# " + pages[root]["title"] + " — Markdown export", "",
             f"Exported {len(records)} pages. This is a read-only, non-transactional snapshot.", "",
             "Attachments remain links. Comments are excluded. Database rows and folder contents are not expanded.", "",
             "See export-manifest.json for failures, omitted content and completeness.", "", "## Pages", ""]
    for id, path in paths.items():
        depth, parent = 0, id
        while parent in parents:
            depth, parent = depth + 1, parents[parent]
        index.append("  " * depth + f'- [{pages[id]["title"]}]({quote(str(path), safe="/.-_~")})')
    (destination / "README.md").write_text("\n".join(index) + "\n")
    broken = []
    for file in destination.rglob("*.md"):
        for code, prose in segments(file.read_text()):
            if code:
                continue
            for href in re.findall(r"\]\(([^)]+\.md)\)", prose):
                if re.match(r"^[a-z][a-z0-9+.-]*:", href, re.I):
                    continue
                if not (file.parent / unquote(href)).is_file():
                    broken.append({"file": str(file.relative_to(destination)), "href": href})
    result = {"root": root, "exported_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "page_count": len(records), "blank_pages": sum(item["blank"] for item in records),
              "complete": not (state["failures"] or state["warnings"] or broken),
              "failures": state["failures"], "warnings": state["warnings"], "broken_links": broken, "pages": records}
    write_json(destination / "export-manifest.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("page", help="Notion page URL or UUID")
    parser.add_argument("destination", type=Path, help="New export directory (must not exist)")
    parser.add_argument("--tool-id", required=True, help="Exact granted Toolplane notion-fetch ID")
    parser.add_argument("--cli", type=Path, default=Path(__file__).resolve().parents[5] / "src/cli.ts")
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--max-pages", type=int, default=500)
    parser.add_argument("--include-transcript", action="store_true")
    args = parser.parse_args()
    if args.destination.exists() or args.destination.is_symlink():
        parser.error("Destination exists; choose a new directory")
    if args.resume and not args.cache:
        parser.error("--resume requires --cache")
    if args.max_pages < 1:
        parser.error("--max-pages must be positive")
    cache = args.cache or Path(".local/notion-exports") / uuid.uuid4().hex
    cache.parent.mkdir(parents=True, exist_ok=True)
    if not args.tool_id.endswith("::notion-fetch"):
        parser.error("--tool-id must identify notion-fetch")
    prefix = ["bun", str(args.cli.resolve()), "call", args.tool_id]

    def fetch(id):
        completed = subprocess.run(prefix + [json.dumps({
            "id": id, "include_transcript": args.include_transcript,
        })], check=True, capture_output=True, text=True, timeout=90)
        response = json.loads(completed.stdout)
        if "approval" in response or "result" not in response:
            raise ValueError("Export requires a granted first-party Notion fetch capability")
        return response["result"]

    print(json.dumps({"cache": str(cache.resolve()), "mode": "read_only"}), flush=True)
    state = crawl(page_id(args.page), fetch, cache, args.resume, args.max_pages)
    result = render(cache, args.destination)
    print(json.dumps({"directory": str(args.destination.resolve()), "page_count": result["page_count"],
                      "blank_pages": result["blank_pages"], "complete": result["complete"],
                      "failures": len(state["failures"]), "warnings": len(state["warnings"]),
                      "broken_links": len(result["broken_links"])}, ensure_ascii=False))
    return 0 if result["complete"] else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        sys.exit(f"Export stopped ({type(error).__name__}); inspect the private cache before resuming.")
