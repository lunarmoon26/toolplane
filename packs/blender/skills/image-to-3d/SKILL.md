---
name: image-to-3d
description: Convert one photo into a textured 3D model using Meshy and import it into the open Blender scene. Use when a user provides one image and asks to make it 3D in Blender.
---

# Image to 3D

Requires `MESHY_API_KEY`, a local image path or public image URL, and the
native `blender` tool. Confirm the output directory before downloading.

1. For a local image, encode it as a data URI with `base64 -i <image-path>`.
2. Create the Meshy task:

```bash
curl -sS https://api.meshy.ai/openapi/v1/image-to-3d \
  -X POST -H "Authorization: Bearer ${MESHY_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"image_url":"<data-uri-or-url>","ai_model":"meshy-6","enable_pbr":true,"should_remesh":true,"should_texture":true,"topology":"quad","target_polycount":30000,"target_formats":["glb"]}'
```

3. Poll `GET /openapi/v1/image-to-3d/<task-id>` every 10 seconds. On
   `SUCCEEDED`, download `model_urls.glb` to the approved absolute path.
4. Import without deleting the current scene. Pass this code to `blender`:

```python
import bpy

before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath="/absolute/path/to/model.glb")
imported = [obj.name for obj in bpy.data.objects if obj not in before]
result = {"imported": imported}
```

Only clear the scene after explicit user approval. Report Meshy `402`, `429`,
or `FAILED` responses without retrying blindly.
