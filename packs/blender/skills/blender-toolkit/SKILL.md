---
name: blender-toolkit
description: Automate Blender geometry, materials, modifiers, collections, and animation through the native Blender tool. Use when a task asks to create or modify scene objects, materials, modifiers, collections, or animation.
---

# Blender Toolkit

Load `toolplane-integrations` first. This pack uses the local TCP bridge, not
the separate Dev-GOM WebSocket add-on. Resolve `blender` through Toolplane for
focused `bpy` snippets and begin with a granted scene-inspection capability.

- Geometry: create primitives, then return names and dimensions in `result`.
- Materials: inspect slots first; create or replace materials only with user
  approval.
- Modifiers: report existing modifiers, add one targeted modifier, then query
  its settings. Apply a modifier only if explicitly requested.
- Collections: query hierarchy before linking or moving objects.
- Animation: inspect actions and frame range before inserting keyframes.
- Retargeting: require the source armature, target armature, and animation file
  paths. Do not guess bone mappings; show the proposed mapping for approval.

Never reset the scene, delete objects, save files, or render unless explicitly
requested. Every call must assign a JSON-serializable dictionary to `result`.
