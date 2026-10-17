---
name: polyhaven-hdri-showcase
description: Compare a Blender product under several Poly Haven HDRIs. Use when a user asks to test environments, compare lighting, or create an HDRI render comparison.
---

# Poly Haven HDRI Showcase

Use `polyhaven` `action: "search"` with `asset_type: "hdri"` to choose a small
approved set. Then use `action: "hdri_showcase"` with an absolute empty output
directory, comma-separated `assets` or a `studios`, `outdoor`, `dramatic`, or
`all` preset, resolution, render dimensions, and samples.

The tool refuses to overwrite PNGs, requires an active camera unless
`create_camera` is approved, uses temporary world data for the comparison, and
restores the original world and render settings afterward. Attribute every HDRI
and render to Poly Haven.
