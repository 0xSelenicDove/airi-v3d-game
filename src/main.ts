import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { World, dist } from './world'
import { Agent } from './agent'
import { Social } from './social'
import { MockBrain, LLMBrain } from './brain'
import { Avatar } from './avatar'
import { MemoryStream } from './memory'
import { Speaker, type VoiceStyle } from './tts'
import type { Persona } from './types'

const world = new World()
// Configure via .env (see .env.example). Without VITE_LLM_URL the mock brain is used.
const env = import.meta.env
const brain = env.VITE_LLM_URL
  ? new LLMBrain({ url: env.VITE_LLM_URL, model: env.VITE_LLM_MODEL ?? 'default', apiKey: env.VITE_LLM_KEY, systemRole: env.VITE_LLM_SYSTEM_ROLE === '1' })
  : new MockBrain()

const personas: Persona[] = [
  { name: 'Airi', description: 'A curious night-owl who loves reading and computers.', color: 0xff8fb8, sleepWindow: [1, 9], bed: 'bed' },
  { name: 'Luna', description: 'A cheerful, sociable early riser. Likes chatting, and also reading.', color: 0x8fd8ff, sleepWindow: [22, 6], bed: 'bed2' },
]
const startPos = [{ x: 0, z: 0 }, { x: -1.5, z: 1.5 }]
const agents = personas.map((p, i) => new Agent(p, startPos[i], brain, world))
// chance meetings: greetings and small talk when two of them run into each other
const social = new Social(world, agents)

// text-to-speech: Airi lower and calmer, Luna higher and brisker; quieter the farther the camera is
const speaker = new Speaker()
const voiceStyles: VoiceStyle[] = [{ pitch: 1.0, rate: 0.95, prefer: 'Daniel' }, { pitch: 1.3, rate: 1.05, prefer: 'Samantha' }]
agents.forEach((a, i) => {
  a.onSay = text => {
    const d = camera.position.distanceTo(new THREE.Vector3(a.pos.x, 1.2, a.pos.z))
    speaker.say(a.persona, text, voiceStyles[i] ?? voiceStyles[0], Math.min(1, Math.max(0.15, 14 / (d + 4))))
  }
})

// ---- persistence: memories + world clock survive reloads (add ?reset to the URL to wipe) ----
const SAVE_KEY = 'airi-v3d-memory-v1'
try {
  if (location.search.includes('reset')) localStorage.removeItem(SAVE_KEY)
  const saved = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null')
  if (saved) {
    world.minutes = saved.minutes ?? world.minutes
    agents.forEach(a => { if (saved.agents?.[a.name]) a.mem = MemoryStream.fromJSON(saved.agents[a.name]) })
  }
} catch (e) { console.warn('could not load saved memory', e) }
function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      minutes: world.minutes,
      agents: Object.fromEntries(agents.map(a => [a.name, a.mem.toJSON()])),
    }))
  } catch { /* storage full or unavailable */ }
}
setInterval(save, 3000)
addEventListener('beforeunload', save)

// ---- three.js scene ----
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(devicePixelRatio)
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)

const labelRenderer = new CSS2DRenderer()
labelRenderer.setSize(innerWidth, innerHeight)
labelRenderer.domElement.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none'
document.body.appendChild(labelRenderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100)
const HOME = { pos: new THREE.Vector3(0, 9, 11), target: new THREE.Vector3(0, 0.5, 0) }
camera.position.copy(HOME.pos)

// orbit: drag = rotate, right-drag = pan, wheel = zoom. F cycles follow-cam, R resets the view.
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.copy(HOME.target)
controls.enableDamping = true
controls.dampingFactor = 0.08
controls.minDistance = 1.5
controls.maxDistance = 24
controls.maxPolarAngle = Math.PI / 2 - 0.05 // stay above the floor
controls.update()
let follow = -1 // -1 = free camera, otherwise agent index

const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 0.6)
const sun = new THREE.DirectionalLight(0xffffff, 1.2)
sun.position.set(5, 10, 6)
sun.castShadow = true
// cover the whole room, and offset along normals so flat furniture tops do not show shadow acne
sun.shadow.mapSize.set(1024, 1024)
Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7 })
sun.shadow.normalBias = 0.02
sun.shadow.bias = -0.0005
sun.shadow.camera.updateProjectionMatrix()
scene.add(hemi, sun)

// room: built by tools/blender/build_room.py from the Kenney Furniture Kit. World reads the same layout.
// Walls between the camera and the room fade to a faint ghost, so the camera can orbit freely and the door,
// which stays solid, is still there to open.
const GHOST = 0.08 // opacity of a wall that is in the way
const walls: { meshes: THREE.Mesh[]; hide: () => boolean; fade: number }[] = []
const lampLights: THREE.PointLight[] = []
let doorLeaf: THREE.Object3D | undefined
// outdoor lights from the yard layout (the campfire, the tent lantern): off by day, on after dark
const outdoorLights = world.lights.map(l => {
  const light = new THREE.PointLight(l.color, 0, l.distance, 2)
  light.position.set(l.x, l.y, l.z)
  scene.add(light)
  return { light, base: l.intensity, flicker: l.flicker }
})
let doorAngle = 0
let doorOpen = 0 // 0 closed .. 1 open
new GLTFLoader().load(`${import.meta.env.BASE_URL}models/room.glb`, gltf => {
  gltf.scene.traverse(o => {
    if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true
    // the interaction point empties are data for the build checks, not for rendering
    if (o.name.startsWith('IP_')) o.visible = false
  })
  const { w, d } = world.bounds
  const side: Record<string, () => boolean> = {
    Walls_Front: () => camera.position.z > d / 2,
    Walls_Back: () => camera.position.z < -d / 2,
    Walls_Left: () => camera.position.x < -w / 2,
    Walls_Right: () => camera.position.x > w / 2,
  }
  for (const [name, hide] of Object.entries(side)) {
    const obj = gltf.scene.getObjectByName(name)
    if (!obj) continue
    const meshes: THREE.Mesh[] = []
    obj.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return
      // each wall fades on its own, so it must not share its materials with anything else
      o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone()
      meshes.push(o)
    })
    walls.push({ meshes, hide, fade: 0 })
  }
  // the leaf swings open (about its hinge) when someone is at the door
  doorLeaf = gltf.scene.getObjectByName('DOOR_leaf')
  doorAngle = THREE.MathUtils.degToRad(Number(doorLeaf?.userData.open_angle ?? 0))
  scene.add(gltf.scene)
  // the lamps glow warm at night, the glow fades out with the daylight (see frame())
  gltf.scene.updateMatrixWorld(true)
  for (const name of ['FURN_desk_lamp', 'FURN_bedside_lamp', 'FURN_reading_lamp']) {
    const lamp = gltf.scene.getObjectByName(name)
    if (!lamp) continue
    const light = new THREE.PointLight(0xffc27a, 0, 6, 2)
    const box = new THREE.Box3().setFromObject(lamp)
    light.position.set((box.min.x + box.max.x) / 2, box.max.y - 0.1, (box.min.z + box.max.z) / 2)
    scene.add(light)
    lampLights.push(light)
  }
}, undefined, e => console.warn('room load failed', e))

// surroundings: yard, fence, trees and hills from tools/blender/build_outdoor.py. Pure scenery, no shadows
// (the shadow camera only covers the room), and fog in the sky colour fades the far hills into the horizon.
scene.fog = new THREE.Fog(0xffffff, 30, 85)
new GLTFLoader().load(`${import.meta.env.BASE_URL}models/outdoor.glb`, gltf => {
  // the tent's south side faces the default camera: see-through, so the sleepers can be seen
  gltf.scene.traverse(o => {
    if (o instanceof THREE.Mesh && !Array.isArray(o.material) && o.material.name === 'out_canvas_south') {
      Object.assign(o.material, { transparent: true, opacity: 0.3, depthWrite: false })
    }
  })
  scene.add(gltf.scene)
}, undefined, e => console.warn('outdoor load failed', e))

// avatars: capsule until a VRM loads
const avatars = agents.map(a => {
  const av = new Avatar(a.persona.color)
  scene.add(av.root)
  av.setName(a.name, a.persona.color)
  return av
})
// per-agent models (public/model.vrm, public/model2.vrm); the capsule shows until one loads.
// Vite's SPA fallback serves HTML for missing files, so sniff the "glTF" magic.
// Without your own file, the public sample avatar in public/models/avatars is used (licenses in the README there).
const modelUrls = [
  ['model.vrm', 'models/avatars/vrm1-constraint-twist-sample.vrm'],
  ['model2.vrm', 'models/avatars/seed-san.vrm'],
].map(files => files.map(f => import.meta.env.BASE_URL + f))
async function fetchVrm(url: string) {
  const b = await fetch(url).then(r => (r.ok ? r.blob() : null)).catch(() => null)
  return b && (await b.slice(0, 4).text()) === 'glTF' ? b : null
}
modelUrls.forEach(async (urls, i) => {
  if (!avatars[i]) return
  for (const u of urls) {
    const b = await fetchVrm(u)
    if (!b) continue
    const url = URL.createObjectURL(b)
    await avatars[i].load(url).catch(e => console.warn('VRM load failed', u, e))
    URL.revokeObjectURL(url)
    return
  }
})
// drag & drop a .vrm onto the page: it goes to the agent whose half of the screen you drop on
addEventListener('dragover', e => e.preventDefault())
addEventListener('drop', e => {
  e.preventDefault()
  const f = e.dataTransfer?.files[0]
  const i = Math.min(avatars.length - 1, Math.floor((e.clientX / innerWidth) * avatars.length))
  if (f && f.name.toLowerCase().endsWith('.vrm')) avatars[i].loadFile(f).catch(err => console.warn(err))
})

;(window as any).dbg = { world, agents, avatars, camera, controls, brain, social } // handy for console poking

// ---- navigation debug overlay (press G) ----
const debug = new THREE.Group()
debug.visible = false
scene.add(debug)
{
  const cells = world.blockedCells()
  const inst = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(world.cell * 0.95, world.cell * 0.95).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.35, depthWrite: false }),
    cells.length,
  )
  const m = new THREE.Matrix4()
  cells.forEach((c, i) => inst.setMatrixAt(i, m.makeTranslation(c.x, 0.03, c.z)))
  debug.add(inst)
}
const MAX_PATH_POINTS = 32
const pathLines = agents.map(a => {
  // fixed-size buffer + draw range: setFromPoints() cannot shrink an existing attribute
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * MAX_PATH_POINTS), 3))
  geo.setDrawRange(0, 0)
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: a.persona.color }))
  line.frustumCulled = false
  debug.add(line)
  return line
})

const hud = document.getElementById('hud')!
addEventListener('keydown', e => {
  if (e.key === 'g' || e.key === 'G') debug.visible = !debug.visible
  if (e.key === 'm' || e.key === 'M') speaker.toggle()
  if (e.key === 'f' || e.key === 'F') follow = follow + 1 >= agents.length ? -1 : follow + 1
  if (e.key === 'r' || e.key === 'R') {
    follow = -1
    camera.position.copy(HOME.pos)
    controls.target.copy(HOME.target)
  }
  if (e.key === '1') world.speed = 10
  if (e.key === '2') world.speed = 60
  if (e.key === '3') world.speed = 240
})
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight)
  labelRenderer.setSize(innerWidth, innerHeight)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
})

const dayColor = new THREE.Color(0x9ec8ff)
const nightColor = new THREE.Color(0x0a0f24)
let last = performance.now()
function frame(now: number) {
  requestAnimationFrame(frame)
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  const gameDt = world.advance(dt)
  agents.forEach(a => a.tick(dt, gameDt))
  social.update(dt)

  // day/night
  const h = world.minutes / 60 % 24
  const daylight = Math.max(0, Math.sin(((h - 6) / 24) * Math.PI * 2))
  const sky = nightColor.clone().lerp(dayColor, daylight)
  scene.background = sky
  ;(scene.fog as THREE.Fog).color.copy(sky)
  sun.intensity = 0.2 + daylight * 1.1
  hemi.intensity = 0.25 + daylight * 0.4
  for (const l of lampLights) l.intensity = (1 - daylight) * 4
  for (const l of outdoorLights) {
    const flick = l.flicker ? Math.sin(now * 0.017) * 0.17 + Math.sin(now * 0.041) * 0.11 : 0
    l.light.intensity = (1 - daylight) * l.base * (1 + flick)
  }
  if (doorLeaf) {
    const near = agents.some(a => dist(a.pos, world.door) < 1.3)
    doorOpen += ((near ? 1 : 0) - doorOpen) * (1 - Math.exp(-dt * 7))
    doorLeaf.rotation.y = doorAngle * doorOpen
  }

  agents.forEach((a, i) => avatars[i].update(dt, a))
  if (debug.visible) {
    agents.forEach((a, i) => {
      const pts = a.state.k === 'moving' ? [a.pos, ...a.state.path] : []
      const pos = pathLines[i].geometry.getAttribute('position') as THREE.BufferAttribute
      const n = Math.min(pts.length, MAX_PATH_POINTS)
      for (let k = 0; k < n; k++) pos.setXYZ(k, pts[k].x, 0.08, pts[k].z)
      pos.needsUpdate = true
      pathLines[i].geometry.setDrawRange(0, n)
    })
  }

  hud.textContent =
    `${world.clock}   speed x${world.speed} (1/2/3 speed, G nav, F follow, R reset, M voice ${speaker.enabled ? 'on' : 'off'})   brain: ${brain instanceof LLMBrain ? 'LLM' : 'mock'}${follow >= 0 ? `   following ${agents[follow].name}` : ''}\n` +
    (brain instanceof LLMBrain && brain.status ? `⚠ ${brain.status}\n` : '') + '\n' +
    agents.map(a => a.statusText + (a.memory.length ? '\n  ' + a.memory.slice(-3).join('\n  ') : '')).join('\n\n')

  if (follow >= 0) {
    // glide the orbit target onto the agent, moving the camera by the same amount to keep the framing
    const a = agents[follow]
    const want = new THREE.Vector3(a.pos.x, a.pose === 'lie' ? 0.6 : 1.0, a.pos.z)
    const delta = want.sub(controls.target).multiplyScalar(1 - Math.exp(-dt * 6))
    controls.target.add(delta)
    camera.position.add(delta)
  }
  controls.update()
  for (const wall of walls) {
    wall.fade += ((wall.hide() ? 1 : 0) - wall.fade) * (1 - Math.exp(-dt * 10))
    const f = wall.fade < 0.01 ? 0 : wall.fade > 0.99 ? 1 : wall.fade
    for (const m of wall.meshes) {
      m.castShadow = f < 0.5 // a ghost must not shade the room
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        // going transparent changes the compiled shader (an opaque material forces alpha to 1)
        if (mat.transparent !== f > 0) { mat.transparent = f > 0; mat.needsUpdate = true }
        mat.opacity = 1 - (1 - GHOST) * f
        mat.depthWrite = f === 0
      }
    }
  }
  renderer.render(scene, camera)
  labelRenderer.render(scene, camera)
}
requestAnimationFrame(frame)
