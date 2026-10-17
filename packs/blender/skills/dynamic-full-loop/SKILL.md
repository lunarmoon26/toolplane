---
name: dynamic-full-loop
description: Create a dynamic multi-axis Blender product orbit with slow reveals and fast whip transitions. Use when a user asks to show every angle, make a speed-ramped loop, or create a dynamic spin.
---

# Dynamic Full Loop

Use the native `blender` tool. Query the subject bounds, then create a tracked
camera parented to an empty at its center. Defaults: 10 seconds, 24 fps, 4.0
unit radius, 1.8 unit camera height. Use clustered `BEZIER` keyframes: small
rotation changes over many frames linger on each face; large changes over few
frames create whips.

Animate the target's Z orbit through 0°, 90°, 180°, 270°, and 360°; add a
moderate X tilt for top and underside views. Keep the first and last pose
consistent if the user requests looping. Return the camera, target, keyframe
count, and frame range in `result`.

Confirm renderer, resolution, samples, transparency, and output path before
rendering. Render PNG frames and use `ffmpeg` to encode them after completion.
