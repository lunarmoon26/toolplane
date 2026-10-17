---
name: slow-zoom
description: Create a cinematic slow camera push-in toward a product detail in Blender. Use when a user asks for a reveal, hero close-up, zoom-in, or cinematic push-in.
---

# Slow Zoom

Use the native `blender` tool. Ask which feature to frame; default to the
selected object's center only when no hero detail is specified. Default to a
5-second, 24 fps animation that moves from 4.0 to 1.8 units away while shifting
from a 35 mm to 65 mm lens.

Create a target empty at the focus point and a camera with a `TRACK_TO`
constraint. At frame 1 keyframe the wide location and lens; at the final frame
keyframe the close location and lens. Keep `BEZIER` interpolation for a smooth
ease in and out. Return the camera, target, and frame range in `result`.

Confirm render settings and output path before rendering. Render a PNG sequence
and encode it with `ffmpeg` to ProRes 4444 when alpha is requested.
