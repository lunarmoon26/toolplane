---
name: blender-threejs-export
description: Export approved Blender meshes to GLB and create a Three.js viewer. Use when a user asks to export a model for the web, build a Three.js preview, or produce an interactive GLB viewer.
---

# Blender Three.js Export

Confirm the absolute output directory, filename, selected objects, whether the
viewer may use the Three.js CDN, background color, auto-rotation, and whether
to embed the GLB. Export only after those decisions are explicit.

Use `threejs_export`. It exports the current Blender selection only, refuses to
overwrite an existing `<name>.glb` or `<name>.html`, and does not alter source
materials. It produces:

- a GLB with meshes, materials, UVs, normals, and images;
- a responsive, accessible standalone viewer with pinned Three.js,
  `GLTFLoader`, and `OrbitControls`;
- model-bound camera framing, neutral studio lights, reset, auto-rotate, and
  transparent-background controls.

By default the viewer loads `./<name>.glb`; serve its output directory over
HTTP (for example, `bunx serve .`). Set `embed: true` only when a self-contained
HTML file outweighs its larger size. The viewer still loads Three.js from its
pinned CDN.
