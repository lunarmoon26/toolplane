---
name: perfect-loop
description: Create a seamless 360-degree looping Blender turntable. Use when a user asks for an infinite loop, looping product spin, GIF, or seamless turntable.
---

# Perfect Loop

Use the native `blender` tool. Query the subject center, create a target empty,
then add and parent a tracked camera. Defaults: 5 seconds, 24 fps, 4.0 unit
distance, 2.0 unit height, and a 50 mm lens.

Set the scene render range to frames `1..N`, where `N = duration * fps`.
Keyframe 0° at frame 1 and 360° at frame `N + 1`; frame `N + 1` must not be
rendered. Set every rotation keyframe to `LINEAR`, and do not animate camera
distance, height, or lens. Return the camera, target, and frame range in a
JSON-safe `result`.

Confirm render settings and output path before rendering. Render a PNG sequence
and encode only completed frames with `ffmpeg`; play the output on repeat to
verify the seam.
