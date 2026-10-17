---
name: crane-shot
description: Create a low-to-high Blender camera reveal around a product. Use when a user asks for a crane shot, rising camera, unveil, or dramatic vertical reveal.
---

# Crane Shot

Use the native `blender` tool. Query the subject bounds first. Create a target
empty near the subject center and a camera with a `TRACK_TO` constraint.
Defaults: 5 seconds at 24 fps; height -0.2→3.5; distance 3.0→4.0; lens 45→35
mm. Keyframe the low starting pose at frame 1 and the elevated, pulled-back
pose at the final frame with `BEZIER` interpolation.

Return camera, target, and frame range in a JSON-safe `result`. Confirm render
settings and destination before starting a render; use a PNG sequence and
encode the completed frames with `ffmpeg` if a video file is requested.
