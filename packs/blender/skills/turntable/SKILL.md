---
name: turntable
description: Create a 360-degree turntable camera orbit around an existing Blender product. Use when a user asks for a product spin, orbit, turntable, or all-angle showcase video.
---

# Turntable

Use the native `blender` tool for each Python block. Query the target object's
bounding box first; ask the user to choose the front angle if it is unclear.
Default to 5 seconds, 24 fps, 4.5 unit radius, 2 unit height, and a 50 mm lens.

Create an empty at the object center, add a camera at the chosen front angle,
give it a `TRACK_TO` constraint aimed at the empty, and parent it to the empty.
Set the render range to `1..N`, where `N = duration * fps`. Set frame 1 to 0°
and frame `N + 1` to 360° so the final rendered frame does not duplicate frame
1. Set all rotation keyframes to `LINEAR`.

Every call must end with JSON-safe output, for example:

```python
result = {"camera": cam.name, "target": target.name, "frames": total_frames}
```

Before rendering, confirm resolution, renderer, samples, output directory, and
whether transparent background is wanted. Render a PNG sequence, then encode
only after the frames exist:

```bash
ffmpeg -framerate 24 -i "<frames>/%04d.png" \
  -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le "<output>.mov"
```

If the output movie already exists, ask before adding `-y` to overwrite it.
