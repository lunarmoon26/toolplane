---
name: dolly-rotate
description: Create a camera move that pushes forward while orbiting a Blender product. Use when a user asks for a dolly, sweeping reveal, or simultaneous move-and-rotate shot.
---

# Dolly Rotate

Use the native `blender` tool in small calls. First query and confirm the
subject center. Create an empty target and a camera constrained to track it;
parent the camera to the target. Defaults: 5 seconds at 24 fps, 90° orbit,
distance 4.0→2.5, height 2.0→1.5, lens 40→50 mm.

At frame 1 keyframe the target at 0° and the camera's start location/lens. At
the final frame keyframe the target Z rotation, end location, and end lens.
Use `BEZIER` interpolation. Each Blender call must set a JSON-safe `result`,
including changed object names and frame range.

Get approval for renderer, resolution, and output path before rendering a PNG
sequence. Encode with `ffmpeg` after frames finish.
