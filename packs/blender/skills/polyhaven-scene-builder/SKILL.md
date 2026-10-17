---
name: polyhaven-scene-builder
description: Build a product scene with Poly Haven HDRIs, materials, ground planes, pedestals, and optional props. Use when a user asks for a product showcase, pedestal, showroom, or styled Blender scene.
---

# Poly Haven Scene Builder

Use the native `polyhaven` tool—never the legacy port-9876 scripts. Credit
Poly Haven in user-facing output. Begin by querying the product object and its
bounds with `blender`.

1. Use `polyhaven` with `action: "search"` to find an approved HDRI, texture,
   or model.
2. Use `action: "scene_builder"` with a `showroom`, `outdoor`, `minimal`, or
   `dramatic` preset, or explicit `hdri` and optional `ground` asset IDs.
3. Pass `pedestal: true` and the queried product `object` only when approved.
   The tool sizes the pedestal from that exact mesh's world-space bounds.
4. Supply approved comma-separated model IDs through `props`.

The tool creates named ground and pedestal objects without removing existing
scene objects, configures the viewport for rendered world lighting, and reports
every Poly Haven asset it uses.
