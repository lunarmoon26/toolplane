---
name: polyhaven-texture-apply
description: Find and apply a CC0 Poly Haven PBR texture to a Blender object. Use when a user asks for Poly Haven materials, realistic metal, wood, concrete, marble, fabric, or surface changes.
---

# Poly Haven Texture Apply

Use `polyhaven` rather than a legacy Node script.

1. Query the target object with `blender`; never infer its name.
2. Search with `polyhaven` `action: "search"`, `asset_type: "texture"`, and a
   concise material query.
3. Confirm the selected asset and resolution. `1k` is a safe preview default;
   use `2k` for ordinary renders and obtain approval before `4k` or `8k`.
4. Apply it with `action: "apply_texture"`, `asset`, `object`, `resolution`,
   and optional Mapping-node `scale`.

The native tool creates a Principled material with diffuse, roughness, and
OpenGL normal maps when those files are available, replacing the target's first
material slot. State this replacement before applying it, and report Poly Haven
as the asset source.
