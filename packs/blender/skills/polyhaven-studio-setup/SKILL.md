---
name: polyhaven-studio-setup
description: Set up Blender product lighting with a Poly Haven HDRI and optional textured ground. Use when a user asks for a studio setup, HDRI lighting, product photography, or a showroom scene.
---

# Poly Haven Studio Setup

Query the current world first and obtain approval before replacing its
environment. Then use `polyhaven` `action: "studio_setup"` with an HDRI asset
ID, optional ground texture asset ID, resolution, `strength`, `rotation`, and
`ground_size`. Default to a `1k` HDRI for previews and `2k` for final renders.
Confirm higher resolutions before downloading.

The tool applies HDRI strength and rotation using named world nodes, can create
and texture a named ground plane, and switches open 3D viewports to rendered
world lighting. It refuses to replace an existing OpenCode studio-ground object.
Attribute the HDRI and textures to Poly Haven.
