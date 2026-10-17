import { tool } from "./tool"
import { blenderBridge, executeBlenderCode } from "./bridge"
import { polyhavenTool } from "./polyhaven"
import { threeJsExportTool } from "./threejs"

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function blenderStatusCode() {
  return `
import bpy

scene = bpy.context.scene
result = {
    "blender_version": bpy.app.version_string,
    "scene": scene.name,
    "object_count": len(scene.objects),
    "active_camera": scene.camera.name if scene.camera else None,
    "world": scene.world.name if scene.world else None,
}
`
}

function sceneInfoCode(limit: number) {
  return `
import bpy

scene = bpy.context.scene
objects = list(scene.objects)
limit = ${JSON.stringify(limit)}
result = {
    "scene": scene.name,
    "world": scene.world.name if scene.world else None,
    "camera": scene.camera.name if scene.camera else None,
    "active_object": bpy.context.active_object.name if bpy.context.active_object else None,
    "selected_objects": [obj.name for obj in bpy.context.selected_objects],
    "render_engine": scene.render.engine,
    "object_count": len(objects),
    "returned_object_count": min(len(objects), limit),
    "truncated": len(objects) > limit,
    "objects": [
        {"name": obj.name, "type": obj.type, "hidden": obj.hide_viewport, "selected": obj.select_get()}
        for obj in objects[:limit]
    ],
}
`
}

function sceneInfoLimit(value: number) {
  return Number.isInteger(value) && value > 0 && value <= 1000 ? value : 200
}

function objectInfoCode(objectName: string) {
  return `
import bpy
from mathutils import Vector

obj = bpy.data.objects.get(${JSON.stringify(objectName)})
if obj is None:
    raise RuntimeError("Object not found: " + ${JSON.stringify(objectName)})
world_bounds = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box] if hasattr(obj, "bound_box") else []
result = {
    "name": obj.name,
    "type": obj.type,
    "location": list(obj.location),
    "rotation": list(obj.rotation_euler),
    "scale": list(obj.scale),
    "dimensions": list(obj.dimensions),
    "materials": [material.name if material else None for material in getattr(obj.data, "materials", [])],
    "world_bounds": [[point.x, point.y, point.z] for point in world_bounds],
}
`
}

async function execute(title: string, code: string, context: { metadata: (value: { title: string; metadata: unknown }) => void }) {
  try {
    context.metadata({ title, metadata: blenderBridge })
    const response = await executeBlenderCode(code)
    return { title, output: JSON.stringify(response, null, 2) }
  } catch (error) {
    return { title, output: `Blender MCP call failed: ${errorMessage(error)}` }
  }
}

export default (async () => ({
  tool: {
    blender: tool({
      description:
        "Execute focused Python through Blender's local MCP bridge. The code must assign a JSON-serializable dictionary to result. Query scene state before mutating it; do not delete, reset, save, or render unless explicitly requested.",
      args: {
        code: tool.schema
          .string()
          .describe("Python executed in Blender. Assign a JSON-serializable dictionary to result."),
      },
      execute: ({ code }, context) => execute("Blender: execute", code, context),
    }),
    blender_status: tool({
      description: "Check the configured Blender bridge and return read-only Blender, scene, camera, and world status.",
      args: {},
      execute: (_args, context) => execute("Blender: status", blenderStatusCode(), context),
    }),
    blender_scene_info: tool({
      description: "Return read-only scene, camera, render, selection, and bounded object summaries from Blender.",
      args: {
        limit: tool.schema.number().default(200).describe("Maximum objects to return, from 1 through 1000."),
      },
      execute: ({ limit }, context) => execute("Blender: scene info", sceneInfoCode(sceneInfoLimit(limit)), context),
    }),
    blender_object_info: tool({
      description: "Return read-only transform, dimensions, materials, and world bounds for a named Blender object.",
      args: {
        object: tool.schema.string().describe("Exact Blender object name."),
      },
      execute: ({ object }, context) => execute("Blender: object info", objectInfoCode(object), context),
    }),
    polyhaven: polyhavenTool(),
    threejs_export: threeJsExportTool(),
  },
}))
