---
name: multi-image-to-3d
description: Convert 1-4 photos of the same object into a textured 3D model using Meshy and import it into the open Blender scene. Use when a user supplies multiple angles and asks for a more accurate Blender model.
---

# Multi-Image to 3D

Requires `MESHY_API_KEY`, one to four images of the same object, and the
native `blender` tool. Prefer front, back, and side views with consistent
lighting and plain backgrounds.

1. Encode local images as data URIs, then write a payload file:

```json
{
  "image_urls": ["<data-uri-or-public-url>"],
  "ai_model": "meshy-6",
  "enable_pbr": true,
  "should_texture": true,
  "target_formats": ["glb"]
}
```

2. `POST https://api.meshy.ai/openapi/v1/multi-image-to-3d` with the payload
   and `Authorization: Bearer ${MESHY_API_KEY}`. Poll the task every 15
   seconds; on `SUCCEEDED`, download `model_urls.glb` to an approved path.
3. Import with `blender`; do not remove existing objects by default:

```python
import bpy

before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath="/absolute/path/to/model.glb")
imported = [obj.name for obj in bpy.data.objects if obj not in before]
result = {"imported": imported}
```

If the user explicitly requests a clean scene, query the existing objects,
state which will be removed, then delete only after confirmation. Report
Meshy `400`, `402`, `429`, and `FAILED` responses clearly.
