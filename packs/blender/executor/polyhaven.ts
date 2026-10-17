import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { tool } from "./tool"
import { executeBlenderCode } from "./bridge"

const apiBase = "https://api.polyhaven.com"
const userAgent = "opencode-blender/0.1"
const cacheRoot = join(homedir(), ".cache", "opencode-blender", "polyhaven")
const maxDownloadBytes = 128 * 1024 * 1024

type RecordValue = Record<string, unknown>
type Asset = {
  name?: string
  category?: string
  tags?: string[]
  type?: number
}
type FileEntry = {
  url: string
  size?: number
  md5?: string
  include?: Record<string, FileEntry>
}

let catalogPromise: Promise<Record<string, Asset>> | undefined

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFileEntry(value: unknown): value is FileEntry {
  return isRecord(value) && typeof value.url === "string"
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function python(value: unknown) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error("Cannot serialize undefined Python value")
  return `__import__("json").loads(${JSON.stringify(serialized)})`
}

function requireAssetId(value: string) {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error("Poly Haven asset IDs may contain only lowercase letters, numbers, and underscores")
  return value
}

function normalizeResolution(value: string) {
  if (!/^(1|2|4|8)k$/.test(value)) throw new Error("Resolution must be one of 1k, 2k, 4k, or 8k")
  return value
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { headers: { "User-Agent": userAgent } })
  if (!response.ok) throw new Error(`Poly Haven API returned HTTP ${response.status} for ${path}`)
  return response.json() as Promise<T>
}

function catalog() {
  catalogPromise ??= fetchJson<Record<string, Asset>>("/assets").catch((error) => {
    catalogPromise = undefined
    throw error
  })
  return catalogPromise
}

function resolutionKeys(branch: RecordValue, requested: string) {
  const requestedNumber = Number.parseInt(requested, 10)
  return Object.keys(branch)
    .filter((key) => /^(1|2|4|8)k$/.test(key))
    .sort((left, right) => Math.abs(Number.parseInt(left, 10) - requestedNumber) - Math.abs(Number.parseInt(right, 10) - requestedNumber))
}

function fileFor(files: RecordValue, mapName: string, requested: string, formats: readonly string[]) {
  const map = files[mapName]
  if (!isRecord(map)) return undefined
  for (const resolution of resolutionKeys(map, requested)) {
    const variants = map[resolution]
    if (!isRecord(variants)) continue
    for (const format of formats) {
      const entry = variants[format]
      if (isFileEntry(entry)) return entry
    }
  }
  return undefined
}

function modelFor(files: RecordValue, requested: string) {
  const formats = files.gltf
  if (!isRecord(formats)) return undefined
  for (const resolution of resolutionKeys(formats, requested)) {
    const variants = formats[resolution]
    if (!isRecord(variants)) continue
    for (const entry of Object.values(variants)) {
      if (isFileEntry(entry) && /\.gltf(?:$|\?)/i.test(entry.url)) return entry
    }
  }
  return undefined
}

async function fileExists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function responseBytes(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Poly Haven response has no readable body")

  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks)
      total += value.length
      if (total > maxDownloadBytes) throw new Error(`Poly Haven download exceeds ${maxDownloadBytes} bytes`)
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function cachePath(root: string, requestedPath: string) {
  const target = resolve(root, requestedPath)
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Poly Haven download path escapes its cache directory")
  return target
}

async function download(entry: FileEntry, root: string, requestedPath = basename(new URL(entry.url).pathname)) {
  const destination = cachePath(root, requestedPath)
  if (await fileExists(destination)) {
    const existing = await stat(destination)
    if ((!entry.size || existing.size === entry.size) && (!entry.md5 || createHash("md5").update(await readFile(destination)).digest("hex") === entry.md5)) {
      return destination
    }
    await unlink(destination)
  }

  if (entry.size && entry.size > maxDownloadBytes) {
    throw new Error(`Poly Haven download is ${entry.size} bytes; select a lower resolution or download it manually`)
  }

  const response = await fetch(entry.url, { headers: { "User-Agent": userAgent } })
  if (!response.ok) throw new Error(`Poly Haven download returned HTTP ${response.status}`)
  const length = Number(response.headers.get("content-length"))
  if (Number.isFinite(length) && length > maxDownloadBytes) {
    throw new Error(`Poly Haven download is ${length} bytes; select a lower resolution or download it manually`)
  }

  const bytes = await responseBytes(response)
  if (entry.size && bytes.length !== entry.size) throw new Error("Poly Haven download size does not match its metadata")
  if (entry.md5 && createHash("md5").update(bytes).digest("hex") !== entry.md5) {
    throw new Error("Poly Haven download checksum does not match its metadata")
  }
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.${randomUUID()}.partial`
  await writeFile(temporary, bytes)
  await rename(temporary, destination)
  return destination
}

async function downloadEntry(entry: FileEntry, root: string) {
  const primary = await download(entry, root)
  for (const [includedPath, included] of Object.entries(entry.include ?? {})) {
    await download(included, root, includedPath)
  }
  return primary
}

async function bridge(code: string) {
  const response = await executeBlenderCode(code)
  if (response.status !== "ok") throw new Error(response.message ?? "Blender rejected the Poly Haven operation")
  return response.result
}

async function filesFor(asset: string) {
  return fetchJson<RecordValue>(`/files/${asset}`)
}

async function applyHdri(asset: string, requestedResolution: string, strength = 1, rotation = 0) {
  const files = await filesFor(asset)
  const entry = fileFor(files, "hdri", requestedResolution, ["hdr", "exr"])
  if (!entry) throw new Error(`No HDR or EXR file is available for '${asset}'`)

  const localPath = await downloadEntry(entry, join(cacheRoot, asset, requestedResolution))
  const result = await bridge(`
import bpy
import math

image = bpy.data.images.load(${python(localPath)}, check_existing=True)
world = bpy.context.scene.world or bpy.data.worlds.new("World")
bpy.context.scene.world = world
world.use_nodes = True
nodes = world.node_tree.nodes
links = world.node_tree.links
background = nodes.get("Background") or nodes.new("ShaderNodeBackground")
environment = nodes.get("OpenCode Poly Haven HDRI") or nodes.new("ShaderNodeTexEnvironment")
mapping = nodes.get("OpenCode Poly Haven HDRI Mapping") or nodes.new("ShaderNodeMapping")
mapping.name = "OpenCode Poly Haven HDRI Mapping"
mapping.label = "Poly Haven HDRI Rotation"
texture_coordinate = nodes.get("OpenCode Poly Haven HDRI Coordinates") or nodes.new("ShaderNodeTexCoord")
texture_coordinate.name = "OpenCode Poly Haven HDRI Coordinates"
environment.name = "OpenCode Poly Haven HDRI"
environment.label = "Poly Haven: ${asset}"
environment.image = image
mapping.inputs["Rotation"].default_value[2] = math.radians(${python(rotation)})
background.inputs["Strength"].default_value = ${python(strength)}
links.new(texture_coordinate.outputs["Generated"], mapping.inputs["Vector"])
links.new(mapping.outputs["Vector"], environment.inputs["Vector"])
links.new(environment.outputs["Color"], background.inputs["Color"])
result = {"asset": ${python(asset)}, "image": image.name, "path": image.filepath, "strength": ${python(strength)}, "rotation": ${python(rotation)}, "source": "Poly Haven"}
`)
  return { ...asResult(result), source: "Poly Haven", cached_path: localPath }
}

async function applyTexture(asset: string, objectName: string, requestedResolution: string, scale = 1, forceNewMaterial = false) {
  const files = await filesFor(asset)
  const requested = [
    ["Diffuse", ["jpg", "png"]],
    ["Rough", ["jpg", "png"]],
    ["nor_gl", ["jpg", "png"]],
    ["Metalness", ["jpg", "png"]],
    ["AO", ["jpg", "png"]],
  ] as const
  const paths: Record<string, string> = {}
  for (const [map, formats] of requested) {
    const entry = map === "Metalness"
      ? fileFor(files, "Metalness", requestedResolution, formats) ?? fileFor(files, "Metal", requestedResolution, formats)
      : fileFor(files, map, requestedResolution, formats)
    if (entry) paths[map] = await downloadEntry(entry, join(cacheRoot, asset, requestedResolution))
  }
  if (!paths.Diffuse) throw new Error(`No diffuse map is available for '${asset}'`)

  const materialName = `OpenCode Poly Haven ${asset} ${objectName}`
  const result = await bridge(`
import bpy

obj = bpy.data.objects.get(${python(objectName)})
if obj is None or not hasattr(obj.data, "materials"):
    raise RuntimeError("Object " + ${python(objectName)} + " does not support materials")

paths = ${python(paths)}
material = obj.data.materials[0] if obj.data.materials else None
if (
    material is None
    or material.get("opencode_polyhaven_asset") != ${python(asset)}
    or material.get("opencode_polyhaven_object") != obj.name
    or material.get("opencode_polyhaven_resolution") != ${python(requestedResolution)}
    or material.users > 1
    or ${python(forceNewMaterial)}
):
    material = bpy.data.materials.new(${python(materialName)})
material["opencode_polyhaven_asset"] = ${python(asset)}
material["opencode_polyhaven_object"] = obj.name
material["opencode_polyhaven_resolution"] = ${python(requestedResolution)}
material.use_nodes = True
nodes = material.node_tree.nodes
links = material.node_tree.links
nodes.clear()
output = nodes.new("ShaderNodeOutputMaterial")
principled = nodes.new("ShaderNodeBsdfPrincipled")
links.new(principled.outputs["BSDF"], output.inputs["Surface"])
texture_coordinate = nodes.new("ShaderNodeTexCoord")
mapping = nodes.new("ShaderNodeMapping")
mapping.inputs["Scale"].default_value = (${python(scale)}, ${python(scale)}, ${python(scale)})
links.new(texture_coordinate.outputs["Generated"], mapping.inputs["Vector"])

def image_node(label, path, non_color=False):
    image = bpy.data.images.load(path, check_existing=True)
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    node = nodes.new("ShaderNodeTexImage")
    node.label = label
    node.image = image
    links.new(mapping.outputs["Vector"], node.inputs["Vector"])
    return node

diffuse = image_node("Poly Haven Diffuse", paths["Diffuse"])
links.new(diffuse.outputs["Color"], principled.inputs["Base Color"])
if "Rough" in paths:
    roughness = image_node("Poly Haven Roughness", paths["Rough"], True)
    links.new(roughness.outputs["Color"], principled.inputs["Roughness"])
if "Metalness" in paths:
    metalness = image_node("Poly Haven Metalness", paths["Metalness"], True)
    links.new(metalness.outputs["Color"], principled.inputs["Metallic"])
if "nor_gl" in paths:
    normal_texture = image_node("Poly Haven Normal", paths["nor_gl"], True)
    normal = nodes.new("ShaderNodeNormalMap")
    links.new(normal_texture.outputs["Color"], normal.inputs["Color"])
    links.new(normal.outputs["Normal"], principled.inputs["Normal"])

if obj.data.materials:
    obj.data.materials[0] = material
else:
    obj.data.materials.append(material)
result = {"asset": ${python(asset)}, "object": obj.name, "material": material.name, "maps": sorted(paths), "scale": ${python(scale)}, "source": "Poly Haven"}
`)
  return { ...asResult(result), source: "Poly Haven", cached_maps: paths }
}

async function importModel(asset: string, requestedResolution: string) {
  const files = await filesFor(asset)
  const entry = modelFor(files, requestedResolution)
  if (!entry) throw new Error(`No glTF model is available for '${asset}'`)

  const root = join(cacheRoot, asset, requestedResolution)
  const localPath = await downloadEntry(entry, root)
  const result = await bridge(`
import bpy

before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=${python(localPath)})
result = {"asset": ${python(asset)}, "imported": [obj.name for obj in bpy.data.objects if obj not in before], "source": "Poly Haven"}
`)
  return { ...asResult(result), source: "Poly Haven", cached_path: localPath }
}

function asResult(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { result: value }
}

const showcasePresets: Record<string, string[]> = {
  studios: ["studio_small_09", "studio_small_08", "studio_small_03", "photo_studio_loft_hall"],
  outdoor: ["kloppenheim_06_puresky", "meadow_2", "snowy_park_01", "venice_sunset"],
  dramatic: ["industrial_sunset_02_puresky", "royal_esplanade", "abandoned_tiled_room", "moonless_golf"],
}
showcasePresets.all = [...showcasePresets.studios, ...showcasePresets.outdoor, ...showcasePresets.dramatic]

const defaultShowcaseHdris = ["studio_small_09", "studio_small_08", "royal_esplanade", "kloppenheim_06_puresky", "industrial_sunset_02_puresky", "venice_sunset"]
const scenePresets: Record<string, { hdri: string; ground: string; pedestal: boolean }> = {
  showroom: { hdri: "studio_small_09", ground: "marble_01", pedestal: true },
  outdoor: { hdri: "kloppenheim_06_puresky", ground: "concrete_wall_003", pedestal: false },
  minimal: { hdri: "studio_small_03", ground: "", pedestal: false },
  dramatic: { hdri: "industrial_sunset_02_puresky", ground: "concrete_floor_02", pedestal: true },
}

function requirePositiveNumber(name: string, value: number, maximum: number) {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new Error(`${name} must be greater than 0 and no more than ${maximum}`)
  return value
}

function requireNumberInRange(name: string, value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`)
  return value
}

function requirePositiveInteger(name: string, value: number, maximum: number) {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) throw new Error(`${name} must be a whole number greater than 0 and no more than ${maximum}`)
  return value
}

function requireOutputDirectory(value: string) {
  if (!value) throw new Error("An absolute output directory is required")
  if (!isAbsolute(value)) throw new Error("Output directory must be absolute")
  return resolve(value)
}

function assetList(value: string) {
  const assets = value.split(",").map((asset) => asset.trim()).filter(Boolean).map(requireAssetId)
  if (new Set(assets).size !== assets.length) throw new Error("Asset lists may not contain duplicate IDs")
  return assets
}

async function preflightStudioSetup(ground: string) {
  return bridge(`
import bpy

if ${python(Boolean(ground))} and bpy.data.objects.get("OpenCode Studio Ground") is not None:
    raise RuntimeError("Refusing to replace existing object: OpenCode Studio Ground")
result = {"ready": True}
`)
}

async function preflightSceneBuild(ground: string, pedestal: boolean, objectName: string) {
  return bridge(`
import bpy

if ${python(Boolean(ground))} and bpy.data.objects.get("OpenCode Scene Ground") is not None:
    raise RuntimeError("Refusing to replace existing object: OpenCode Scene Ground")
if ${python(pedestal)}:
    product = bpy.data.objects.get(${python(objectName)})
    if product is None or product.type != "MESH":
        raise RuntimeError("Product object must be an existing mesh: " + ${python(objectName)})
    if bpy.data.objects.get("OpenCode Pedestal") is not None:
        raise RuntimeError("Refusing to replace existing object: OpenCode Pedestal")
result = {"ready": True}
`)
}

async function configureRenderedViewport() {
  return bridge(`
import bpy

for area in bpy.context.screen.areas:
    if area.type != "VIEW_3D":
        continue
    for space in area.spaces:
        if space.type == "VIEW_3D":
            space.shading.type = "RENDERED"
            space.shading.use_scene_world = True
result = {"viewport": "rendered"}
`)
}

async function createGround(name: string, size: number) {
  return asResult(await bridge(`
import bpy

if bpy.data.objects.get(${python(name)}) is not None:
    raise RuntimeError("Refusing to replace existing object: " + ${python(name)})
bpy.ops.mesh.primitive_plane_add(size=${python(size)}, location=(0, 0, -0.01))
plane = bpy.context.active_object
plane.name = ${python(name)}
result = {"ground": plane.name, "size": ${python(size)}}
`))
}

async function createPedestal(productName: string, name: string) {
  return asResult(await bridge(`
import bpy
from mathutils import Vector

product = bpy.data.objects.get(${python(productName)})
if product is None or product.type != "MESH":
    raise RuntimeError("Product object must be an existing mesh: " + ${python(productName)})
if bpy.data.objects.get(${python(name)}) is not None:
    raise RuntimeError("Refusing to replace existing object: " + ${python(name)})
corners = [product.matrix_world @ Vector(corner) for corner in product.bound_box]
min_x, max_x = min(corner.x for corner in corners), max(corner.x for corner in corners)
min_y, max_y = min(corner.y for corner in corners), max(corner.y for corner in corners)
min_z = min(corner.z for corner in corners)
radius = max(max_x - min_x, max_y - min_y) * 0.7
if radius <= 0:
    raise RuntimeError("Product object has no usable dimensions")
bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=0.08, location=((min_x + max_x) / 2, (min_y + max_y) / 2, min_z - 0.04))
pedestal = bpy.context.active_object
pedestal.name = ${python(name)}
bpy.ops.object.shade_smooth()
material = bpy.data.materials.new("OpenCode Pedestal Material")
material.use_nodes = True
principled = next((node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
if principled:
    principled.inputs["Base Color"].default_value = (0.02, 0.02, 0.02, 1)
    principled.inputs["Roughness"].default_value = 0.1
    principled.inputs["Metallic"].default_value = 0.3
pedestal.data.materials.append(material)
result = {"pedestal": pedestal.name, "radius": radius}
`))
}

async function studioSetup(hdri: string, ground: string, resolution: string, strength: number, rotation: number, groundSize: number) {
  await preflightStudioSetup(ground)
  const environment = await applyHdri(hdri, resolution, strength, rotation)
  let groundResult: Record<string, unknown> | undefined
  let groundMaterial: Record<string, unknown> | undefined
  if (ground) {
    groundResult = await createGround("OpenCode Studio Ground", groundSize)
    groundMaterial = await applyTexture(ground, "OpenCode Studio Ground", resolution, 3)
  }
  await configureRenderedViewport()
  return { environment, ground: groundResult, ground_material: groundMaterial, source: "Poly Haven" }
}

async function buildScene(
  preset: string,
  hdriValue: string,
  groundValue: string,
  pedestal: boolean,
  pedestalTexture: string,
  propsValue: string,
  objectName: string,
  resolution: string,
) {
  const selectedPreset = preset ? scenePresets[preset] : undefined
  if (preset && !selectedPreset) throw new Error("Scene preset must be showroom, outdoor, minimal, or dramatic")
  const hdri = requireAssetId(hdriValue || selectedPreset?.hdri || "studio_small_09")
  const ground = groundValue || selectedPreset?.ground || ""
  const shouldAddPedestal = pedestal || selectedPreset?.pedestal || false
  if (shouldAddPedestal && !objectName) throw new Error("scene_builder requires object when adding a pedestal")
  const groundAsset = ground ? requireAssetId(ground) : ""
  const pedestalAsset = pedestalTexture ? requireAssetId(pedestalTexture) : groundAsset
  const props = assetList(propsValue)
  await preflightSceneBuild(groundAsset, shouldAddPedestal, objectName)
  const environment = await applyHdri(hdri, resolution)
  const result: Record<string, unknown> = { preset: preset || null, environment, source: "Poly Haven" }

  if (groundAsset) {
    result.ground = await createGround("OpenCode Scene Ground", 15)
    result.ground_material = await applyTexture(groundAsset, "OpenCode Scene Ground", resolution, 3)
  }
  if (shouldAddPedestal) {
    result.pedestal = await createPedestal(objectName, "OpenCode Pedestal")
    if (pedestalAsset) result.pedestal_material = await applyTexture(pedestalAsset, "OpenCode Pedestal", resolution, 1)
  }
  if (props.length) result.props = await Promise.all(props.map((asset) => importModel(asset, resolution)))
  await configureRenderedViewport()
  return result
}

async function captureRenderSettings() {
  return asResult(await bridge(`
import bpy

scene = bpy.context.scene
result = {
    "engine": scene.render.engine,
    "samples": scene.cycles.samples,
    "denoising": scene.cycles.use_denoising,
    "resolution_x": scene.render.resolution_x,
    "resolution_y": scene.render.resolution_y,
    "resolution_percentage": scene.render.resolution_percentage,
    "file_format": scene.render.image_settings.file_format,
    "filepath": scene.render.filepath,
}
`))
}

async function configureRender(width: number, height: number, samples: number) {
  return bridge(`
import bpy

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = ${python(samples)}
scene.cycles.use_denoising = True
scene.render.resolution_x = ${python(width)}
scene.render.resolution_y = ${python(height)}
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
result = {"engine": scene.render.engine, "samples": scene.cycles.samples, "resolution": [scene.render.resolution_x, scene.render.resolution_y]}
`)
}

async function restoreRenderSettings(settings: Record<string, unknown>) {
  return bridge(`
import bpy

settings = ${python(settings)}
scene = bpy.context.scene
scene.render.engine = settings["engine"]
scene.cycles.samples = settings["samples"]
scene.cycles.use_denoising = settings["denoising"]
scene.render.resolution_x = settings["resolution_x"]
scene.render.resolution_y = settings["resolution_y"]
scene.render.resolution_percentage = settings["resolution_percentage"]
scene.render.image_settings.file_format = settings["file_format"]
scene.render.filepath = settings["filepath"]
result = {"restored": True}
`)
}

async function ensureCamera(createCamera: boolean) {
  return bridge(`
import bpy
from mathutils import Vector

scene = bpy.context.scene
camera = scene.camera
if camera is None:
    if not ${python(createCamera)}:
        raise RuntimeError("The scene needs an active camera; set create_camera to true to add one")
    bpy.ops.object.camera_add(location=(2.5, -2.5, 1.5))
    camera = bpy.context.active_object
    camera.name = "OpenCode Showcase Camera"
    camera.rotation_euler = (Vector((0, 0, 0)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = camera
result = {"camera": camera.name, "created": ${python(createCamera)}}
`)
}

async function renderStill(path: string) {
  return bridge(`
import bpy

bpy.context.scene.render.filepath = ${python(path)}
bpy.ops.render.render(write_still=True)
result = {"render": ${python(path)}}
`)
}

async function captureMaterialSlots(objectName: string) {
  return asResult(await bridge(`
import bpy

obj = bpy.data.objects.get(${python(objectName)})
if obj is None or not hasattr(obj.data, "materials"):
    raise RuntimeError("Object " + ${python(objectName)} + " does not support materials")
result = {"slots": [material.name if material else None for material in obj.data.materials]}
`))
}

async function restoreMaterialSlots(objectName: string, slots: unknown) {
  return bridge(`
import bpy

obj = bpy.data.objects.get(${python(objectName)})
if obj is None or not hasattr(obj.data, "materials"):
    raise RuntimeError("Object " + ${python(objectName)} + " does not support materials")
slots = ${python(slots)}
obj.data.materials.clear()
for material_name in slots:
    if material_name is None:
        obj.data.materials.append(None)
        continue
    material = bpy.data.materials.get(material_name)
    if material is None:
        raise RuntimeError("Original material no longer exists: " + material_name)
    obj.data.materials.append(material)
result = {"restored_slots": len(slots)}
`)
}

async function createTemporaryWorld() {
  const temporaryWorld = `OpenCode HDRI Preview ${randomUUID()}`
  const result = asResult(await bridge(`
import bpy

scene = bpy.context.scene
original = scene.world
preview = original.copy() if original else bpy.data.worlds.new(${python(temporaryWorld)})
preview.name = ${python(temporaryWorld)}
scene.world = preview
result = {"original_world": original.name if original else None, "preview_world": preview.name}
`))
  if (typeof result.preview_world !== "string") throw new Error("Could not create temporary world")
  return { originalWorld: typeof result.original_world === "string" ? result.original_world : null, previewWorld: result.preview_world }
}

async function restoreWorld(originalWorld: string | null, previewWorld: string) {
  return bridge(`
import bpy

scene = bpy.context.scene
scene.world = bpy.data.worlds.get(${python(originalWorld)}) if ${python(Boolean(originalWorld))} else None
preview = bpy.data.worlds.get(${python(previewWorld)})
if preview and preview.users == 0:
    bpy.data.worlds.remove(preview)
result = {"restored": True}
`)
}

async function prepareOutput(output: string, assetIds: string[]) {
  const directory = requireOutputDirectory(output)
  await mkdir(directory, { recursive: true })
  for (const asset of assetIds) {
    const destination = join(directory, `${asset}.png`)
    if (await fileExists(destination)) throw new Error(`Refusing to overwrite existing render: ${destination}`)
  }
  return directory
}

async function materialSwap(
  objectName: string,
  texturesValue: string,
  output: string,
  resolution: string,
  scale: number,
  width: number,
  height: number,
  samples: number,
  createCamera: boolean,
) {
  if (!objectName) throw new Error("material_swap requires an object")
  const textures = assetList(texturesValue)
  if (!textures.length) throw new Error("material_swap requires one or more comma-separated texture asset IDs")
  const directory = await prepareOutput(output, textures)
  const originalMaterials = await captureMaterialSlots(objectName)
  const renderSettings = await captureRenderSettings()
  await ensureCamera(createCamera)
  const renders: Record<string, unknown>[] = []
  try {
    await configureRender(width, height, samples)
    for (const texture of textures) {
      const material = await applyTexture(texture, objectName, resolution, scale, true)
      const render = await renderStill(join(directory, `${texture}.png`))
      renders.push({ texture, material, render })
    }
  } finally {
    try {
      await restoreMaterialSlots(objectName, originalMaterials.slots)
    } finally {
      await restoreRenderSettings(renderSettings)
    }
  }
  return { object: objectName, output: directory, renders, restored_materials: true, restored_render_settings: true, source: "Poly Haven" }
}

function showcaseAssets(assets: string, preset: string) {
  if (assets.trim()) {
    const values = assetList(assets)
    if (!values.length) throw new Error("HDRI showcase requires one or more asset IDs")
    return values
  }
  if (!preset) return defaultShowcaseHdris
  const values = showcasePresets[preset]
  if (!values) throw new Error("HDRI showcase preset must be studios, outdoor, dramatic, or all")
  return values
}

async function hdriShowcase(
  assetsValue: string,
  preset: string,
  output: string,
  resolution: string,
  width: number,
  height: number,
  samples: number,
  createCamera: boolean,
) {
  const hdris = showcaseAssets(assetsValue, preset)
  const directory = await prepareOutput(output, hdris)
  const renderSettings = await captureRenderSettings()
  let world: { originalWorld: string | null; previewWorld: string } | undefined
  const renders: Record<string, unknown>[] = []
  try {
    world = await createTemporaryWorld()
    await ensureCamera(createCamera)
    await configureRender(width, height, samples)
    for (const hdri of hdris) {
      const environment = await applyHdri(hdri, resolution)
      const render = await renderStill(join(directory, `${hdri}.png`))
      renders.push({ hdri, environment, render })
    }
  } finally {
    try {
      await restoreRenderSettings(renderSettings)
    } finally {
      if (world) await restoreWorld(world.originalWorld, world.previewWorld)
    }
  }
  return { output: directory, renders, restored_world: true, restored_render_settings: true, source: "Poly Haven" }
}

async function search(query: string, assetType: string) {
  const typeByName: Record<string, number | undefined> = { all: undefined, hdri: 0, texture: 1, model: 2 }
  if (!(assetType in typeByName)) throw new Error("asset_type must be all, hdri, texture, or model")
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = Object.entries(await catalog())
    .filter(([, asset]) => typeByName[assetType] === undefined || asset.type === typeByName[assetType])
    .filter(([id, asset]) => {
      const text = [id, asset.name ?? "", asset.category ?? "", ...(asset.tags ?? [])].join(" ").toLowerCase()
      return terms.every((term) => text.includes(term))
    })
    .slice(0, 20)
    .map(([id, asset]) => ({ id, name: asset.name, category: asset.category, type: asset.type }))
  return { source: "Poly Haven", query, asset_type: assetType, matches }
}

export function polyhavenTool() {
  return tool({
    description:
      "Search and import CC0 Poly Haven assets through its public API. Actions: search, apply_hdri, apply_texture, import_model, studio_setup, scene_builder, material_swap, or hdri_showcase. Downloads cache locally and reports Poly Haven as the source.",
    args: {
      action: tool.schema.string().describe("One of: search, apply_hdri, apply_texture, import_model, studio_setup, scene_builder, material_swap, hdri_showcase."),
      asset: tool.schema.string().default("").describe("Poly Haven asset ID for non-search actions."),
      query: tool.schema.string().default("").describe("Search words used only by the search action."),
      asset_type: tool.schema.string().default("all").describe("Search filter: all, hdri, texture, or model."),
      object: tool.schema.string().default("").describe("Blender object name used by apply_texture, material_swap, or scene_builder pedestal placement."),
      resolution: tool.schema.string().default("2k").describe("Preferred asset resolution: 1k, 2k, 4k, or 8k."),
      scale: tool.schema.number().default(1).describe("Texture Mapping node scale used by apply_texture or material_swap."),
      hdri: tool.schema.string().default("").describe("HDRI asset ID used by studio_setup or scene_builder."),
      ground: tool.schema.string().default("").describe("Optional Poly Haven texture asset ID for a created ground plane."),
      ground_size: tool.schema.number().default(10).describe("Created studio ground plane size."),
      strength: tool.schema.number().default(1).describe("World background strength for apply_hdri or studio_setup."),
      rotation: tool.schema.number().default(0).describe("HDRI rotation in degrees for apply_hdri or studio_setup."),
      preset: tool.schema.string().default("").describe("Scene preset: showroom, outdoor, minimal, dramatic; showcase preset: studios, outdoor, dramatic, all."),
      pedestal: tool.schema.boolean().default(false).describe("Create a pedestal beneath the scene_builder object."),
      pedestal_texture: tool.schema.string().default("").describe("Optional Poly Haven texture asset ID for the scene_builder pedestal."),
      props: tool.schema.string().default("").describe("Comma-separated Poly Haven model asset IDs to import in scene_builder."),
      assets: tool.schema.string().default("").describe("Comma-separated texture IDs for material_swap or HDRI IDs for hdri_showcase."),
      output: tool.schema.string().default("").describe("Absolute output directory for material_swap or hdri_showcase PNG renders."),
      render_width: tool.schema.number().default(1920).describe("Comparison render width in pixels."),
      render_height: tool.schema.number().default(1080).describe("Comparison render height in pixels."),
      samples: tool.schema.number().default(64).describe("Cycles samples for material_swap or hdri_showcase renders."),
      create_camera: tool.schema.boolean().default(false).describe("Allow material_swap or hdri_showcase to add a camera if the scene has none."),
    },
    execute: async (args, context) => {
      const options = {
        action: args.action,
        asset: args.asset ?? "",
        query: args.query ?? "",
        assetType: args.asset_type ?? "all",
        object: args.object ?? "",
        resolution: args.resolution ?? "2k",
        scale: args.scale || 1,
        hdri: args.hdri ?? "",
        ground: args.ground ?? "",
        groundSize: args.ground_size || 10,
        strength: args.strength || 1,
        rotation: args.rotation ?? 0,
        preset: args.preset ?? "",
        pedestal: args.pedestal ?? false,
        pedestalTexture: args.pedestal_texture ?? "",
        props: args.props ?? "",
        assets: args.assets ?? "",
        output: args.output ?? "",
        renderWidth: args.render_width || 1920,
        renderHeight: args.render_height || 1080,
        samples: args.samples || 64,
        createCamera: args.create_camera ?? false,
      }
      try {
        context.metadata({ title: `Poly Haven: ${options.action}`, metadata: { action: options.action, asset: options.asset } })
        const resolution = normalizeResolution(options.resolution)
        let result: Record<string, unknown>
        if (options.action === "search") result = await search(options.query, options.assetType)
        else if (options.action === "apply_hdri") {
          result = await applyHdri(
            requireAssetId(options.asset),
            resolution,
            requireNumberInRange("strength", options.strength, 0, 100),
            requireNumberInRange("rotation", options.rotation, -36000, 36000),
          )
        }
        else if (options.action === "apply_texture") {
          if (!options.object) throw new Error("apply_texture requires an object name")
          result = await applyTexture(requireAssetId(options.asset), options.object, resolution, requirePositiveNumber("scale", options.scale, 100))
        } else if (options.action === "import_model") result = await importModel(requireAssetId(options.asset), resolution)
        else if (options.action === "studio_setup") {
          result = await studioSetup(
            requireAssetId(options.hdri || options.asset || "studio_small_09"),
            options.ground ? requireAssetId(options.ground) : "",
            resolution,
            requireNumberInRange("strength", options.strength, 0, 100),
            requireNumberInRange("rotation", options.rotation, -36000, 36000),
            requirePositiveNumber("ground_size", options.groundSize, 10000),
          )
        } else if (options.action === "scene_builder") {
          result = await buildScene(
            options.preset,
            options.hdri || options.asset,
            options.ground,
            options.pedestal,
            options.pedestalTexture,
            options.props,
            options.object,
            resolution,
          )
        } else if (options.action === "material_swap") {
          result = await materialSwap(
            options.object,
            options.assets,
            options.output,
            resolution,
            requirePositiveNumber("scale", options.scale, 100),
            requirePositiveInteger("render_width", options.renderWidth, 16384),
            requirePositiveInteger("render_height", options.renderHeight, 16384),
            requirePositiveInteger("samples", options.samples, 4096),
            options.createCamera,
          )
        } else if (options.action === "hdri_showcase") {
          result = await hdriShowcase(
            options.assets,
            options.preset,
            options.output,
            resolution,
            requirePositiveInteger("render_width", options.renderWidth, 16384),
            requirePositiveInteger("render_height", options.renderHeight, 16384),
            requirePositiveInteger("samples", options.samples, 4096),
            options.createCamera,
          )
        }
        else throw new Error("Unknown Poly Haven action")
        return { title: `Poly Haven: ${options.action}`, output: JSON.stringify(result, null, 2) }
      } catch (error) {
        return { title: `Poly Haven: ${options.action}`, output: `Poly Haven call failed: ${errorMessage(error)}` }
      }
    },
  })
}
