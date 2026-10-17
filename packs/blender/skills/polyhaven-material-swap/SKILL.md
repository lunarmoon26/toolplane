---
name: polyhaven-material-swap
description: Render finish variants of a Blender object with multiple Poly Haven textures. Use when a user asks for material comparisons, finish options, or texture variants.
---

# Poly Haven Material Swap

Query the target object, search approved textures, and then use `polyhaven`
`action: "material_swap"` with the object name, comma-separated `assets`, an
absolute empty `output` directory, resolution, optional texture `scale`, render
dimensions, and samples.

The tool refuses to overwrite PNGs, requires an active camera unless
`create_camera` is approved, restores every material slot and render setting
afterward, and identifies Poly Haven as the source of every variant.
