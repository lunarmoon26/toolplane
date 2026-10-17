---
name: blender-product-polish
description: Import or polish a GLB/GLTF product model with controlled materials and studio lighting in Blender. Use when a user asks to polish a 3D model, prepare a Meshy model, or make a product render-ready.
---

# Blender Product Polish

Use the native `blender` tool. Query the scene first. Never clear the scene,
remove lights, or overwrite materials unless the user explicitly approves each
change.

For an approved GLB/GLTF import:

```python
import bpy

before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath="/absolute/path/to/model.glb")
result = {"imported": [obj.name for obj in bpy.data.objects if obj not in before]}
```

For polishing, inspect the selected materials first. Apply requested Principled
BSDF values—roughness, coat weight, metallic, IOR, and transmission—without
removing texture nodes unless the user specifically asks to replace them.

Add named key, fill, rim, and bounce lights only after confirming whether to
preserve current lights. Set EEVEE or Cycles and any viewport shading change
only on explicit request. Report every created or changed object in `result`.
