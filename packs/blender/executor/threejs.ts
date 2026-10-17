import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join, resolve } from "node:path"
import { tool } from "./tool"
import { executeBlenderCode } from "./bridge"

type ViewerOptions = {
  title: string
  modelSource: string
  background: string
  autoRotate: boolean
}

const maxEmbeddedGlbBytes = 20 * 1024 * 1024

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function scriptJson(value: string | boolean) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;")
}

export function buildViewerHtml(options: ViewerOptions) {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>__HTML_TITLE__</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: __BACKGROUND__; color: #e8f7ff; }
    * { box-sizing: border-box; }
    html, body, #scene { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { background: __BACKGROUND__; }
    canvas { display: block; width: 100%; height: 100%; touch-action: none; }
    .panel { position: fixed; z-index: 1; top: 18px; left: 18px; width: min(300px, calc(100vw - 36px)); padding: 15px; border: 1px solid rgba(0, 229, 255, 0.28); border-radius: 14px; background: rgba(5, 10, 18, 0.82); box-shadow: 0 18px 50px rgba(0, 0, 0, 0.36); backdrop-filter: blur(18px); }
    h1 { margin: 0 0 5px; font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; }
    p { margin: 0; color: #9eb4c0; font-size: 12px; line-height: 1.45; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    button { min-height: 34px; padding: 0 11px; border: 1px solid rgba(0, 229, 255, 0.28); border-radius: 9px; background: rgba(0, 229, 255, 0.08); color: #dffbff; font: inherit; font-size: 12px; cursor: pointer; }
    button:hover { background: rgba(0, 229, 255, 0.16); }
    button:focus-visible { outline: 2px solid #00e5ff; outline-offset: 2px; }
    .error { color: #ff9b9b; }
    @media (max-width: 640px) { .panel { top: 10px; left: 10px; width: min(280px, calc(100vw - 20px)); padding: 12px; } }
  </style>
  <script type="importmap">
    { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/" } }
  </script>
</head>
<body>
  <main id="scene" aria-label="Interactive 3D model viewer"></main>
  <aside class="panel" aria-label="Viewer controls">
    <h1>__HTML_TITLE__</h1>
    <p id="status" role="status">Loading model…</p>
    <div class="actions">
      <button id="reset" type="button">Reset view</button>
      <button id="rotate" type="button" aria-pressed="__AUTO_ROTATE__">Auto-rotate</button>
      <button id="background" type="button" aria-pressed="false">Transparent BG</button>
    </div>
  </aside>
  <script type="module">
    import * as THREE from "three";
    import { OrbitControls } from "three/addons/controls/OrbitControls.js";
    import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

    const config = { modelSource: __MODEL_SOURCE__, background: __BACKGROUND_JSON__, autoRotate: __AUTO_ROTATE__ };
    const mount = document.getElementById("scene");
    const status = document.getElementById("status");
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(config.background);

    const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.01, 10000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.autoRotate = config.autoRotate;
    controls.autoRotateSpeed = 1.25;
    controls.minDistance = 0.01;
    controls.maxDistance = 10000;

    scene.add(new THREE.HemisphereLight(0xddeeff, 0x111827, 2));
    const key = new THREE.DirectionalLight(0xfff5e6, 3);
    key.position.set(4, 6, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xb9d8ff, 1.5);
    fill.position.set(-4, 2, -3);
    scene.add(fill);

    let initialView = null;
    function frameModel(model) {
      const box = new THREE.Box3().setFromObject(model);
      if (box.isEmpty()) throw new Error("The exported model has no visible bounds.");
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z) / 2;
      const distance = Math.max(radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.35, 0.1);
      const position = center.clone().add(new THREE.Vector3(distance * 0.85, distance * 0.55, distance));
      camera.position.copy(position);
      controls.target.copy(center);
      controls.minDistance = Math.max(radius * 0.05, 0.01);
      controls.maxDistance = Math.max(radius * 25, 10);
      initialView = { position: position.clone(), target: center.clone() };
      controls.update();
    }

    document.getElementById("reset").addEventListener("click", () => {
      if (!initialView) return;
      camera.position.copy(initialView.position);
      controls.target.copy(initialView.target);
      controls.update();
    });
    const rotateButton = document.getElementById("rotate");
    rotateButton.addEventListener("click", () => {
      controls.autoRotate = !controls.autoRotate;
      rotateButton.setAttribute("aria-pressed", String(controls.autoRotate));
    });
    const backgroundButton = document.getElementById("background");
    backgroundButton.addEventListener("click", () => {
      const transparent = backgroundButton.getAttribute("aria-pressed") !== "true";
      backgroundButton.setAttribute("aria-pressed", String(transparent));
      backgroundButton.textContent = transparent ? "Solid BG" : "Transparent BG";
      scene.background = transparent ? null : new THREE.Color(config.background);
      renderer.setClearColor(0x000000, transparent ? 0 : 1);
    });

    if (location.protocol === "file:") {
      status.textContent = "Use a local web server to load the GLB, for example: bunx serve .";
      status.classList.add("error");
    }
    new GLTFLoader().load(config.modelSource, (gltf) => {
      gltf.scene.traverse((child) => {
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
      });
      scene.add(gltf.scene);
      frameModel(gltf.scene);
      status.textContent = "Ready — drag to orbit, scroll to zoom, right-drag to pan.";
      status.classList.remove("error");
    }, undefined, (error) => {
      console.error(error);
      status.textContent = "Could not load the GLB. Serve this folder over HTTP and check the browser console.";
      status.classList.add("error");
    });

    addEventListener("resize", () => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });
    function render() {
      requestAnimationFrame(render);
      controls.update();
      renderer.render(scene, camera);
    }
    render();
  </script>
</body>
</html>`

  return html
    .replaceAll("__HTML_TITLE__", escapeHtml(options.title))
    .replaceAll("__MODEL_SOURCE__", scriptJson(options.modelSource))
    .replaceAll("__BACKGROUND_JSON__", scriptJson(options.background))
    .replaceAll("__BACKGROUND__", options.background)
    .replaceAll("__AUTO_ROTATE__", scriptJson(options.autoRotate))
}

function requireOutputDirectory(value: string) {
  if (!value) throw new Error("An absolute output directory is required")
  if (!isAbsolute(value)) throw new Error("Output directory must be absolute")
  return resolve(value)
}

function requireName(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new Error("Name may contain only letters, numbers, underscores, and hyphens")
  }
  return value
}

function requireBackground(value: string) {
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) throw new Error("Background must be a #RGB or #RRGGBB color")
  return value
}

async function pathExists(path: string) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function exportGlb(path: string) {
  const response = await executeBlenderCode(`
import bpy
import os

selected = list(bpy.context.selected_objects)
if not selected:
    raise RuntimeError("Select one or more objects before exporting")
bpy.ops.export_scene.gltf(
    filepath=${JSON.stringify(path)},
    export_format="GLB",
    use_selection=True,
    export_apply=True,
    export_image_format="AUTO",
    export_materials="EXPORT",
    export_texcoords=True,
    export_normals=True,
)
result = {
    "glb": ${JSON.stringify(path)},
    "selected_objects": [obj.name for obj in selected],
    "bytes": os.path.getsize(${JSON.stringify(path)}),
}
`)
  if (response.status !== "ok") throw new Error(response.message ?? "Blender GLB export failed")
  return response.result
}

export function threeJsExportTool() {
  return tool({
    description:
      "Export the currently selected Blender objects as a GLB and generate a responsive Three.js viewer. Requires an explicit absolute output directory and never overwrites existing files.",
    args: {
      output: tool.schema.string().describe("Absolute directory for the generated GLB and HTML viewer."),
      name: tool.schema.string().default("model").describe("Output basename: letters, numbers, underscores, and hyphens only."),
      background: tool.schema.string().default("#111111").describe("Viewer background as #RGB or #RRGGBB."),
      auto_rotate: tool.schema.boolean().default(true).describe("Whether the viewer rotates the model automatically."),
      embed: tool.schema.boolean().default(false).describe("Embed the GLB as a data URL in the HTML instead of loading the neighboring GLB file."),
    },
    execute: async (args, context) => {
      let exportedGlb: string | undefined
      try {
        const output = requireOutputDirectory(args.output)
        const name = requireName(args.name)
        const background = requireBackground(args.background)
        const glbPath = join(output, `${name}.glb`)
        const htmlPath = join(output, `${name}.html`)
        if (await pathExists(glbPath) || await pathExists(htmlPath)) {
          throw new Error(`Refusing to overwrite existing ${basename(glbPath)} or ${basename(htmlPath)}`)
        }

        context.metadata({ title: "Three.js: export", metadata: { output, name, embed: args.embed } })
        await mkdir(output, { recursive: true })
        const blender = await exportGlb(glbPath)
        exportedGlb = glbPath
        let modelSource = `./${basename(glbPath)}`
        if (args.embed) {
          const glbStats = await stat(glbPath)
          if (glbStats.size > maxEmbeddedGlbBytes) {
            throw new Error(`Refusing to embed a GLB larger than ${maxEmbeddedGlbBytes} bytes; use the neighboring GLB file instead`)
          }
          modelSource = `data:model/gltf-binary;base64,${(await readFile(glbPath)).toString("base64")}`
        }
        await writeFile(htmlPath, buildViewerHtml({ title: name, modelSource, background, autoRotate: args.auto_rotate }), { encoding: "utf8", flag: "wx" })
        return {
          title: "Three.js: export",
          output: JSON.stringify({ glb: glbPath, viewer: htmlPath, embedded: args.embed, blender }, null, 2),
        }
      } catch (error) {
        if (exportedGlb) await unlink(exportedGlb).catch(() => undefined)
        return { title: "Three.js: export", output: `Three.js export failed: ${errorMessage(error)}` }
      }
    },
  })
}
