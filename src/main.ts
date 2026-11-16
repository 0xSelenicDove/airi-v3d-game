import * as THREE from 'three'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { World } from './world'
import { Agent } from './agent'
import { MockBrain, LLMBrain } from './brain'
import { Avatar } from './avatar'
import { MemoryStream } from './memory'
import type { Persona } from './types'

const world = new World()
// Configure via .env (see .env.example). Without VITE_LLM_URL the mock brain is used.
const env = import.meta.env
const brain = env.VITE_LLM_URL
  ? new LLMBrain({ url: env.VITE_LLM_URL, model: env.VITE_LLM_MODEL ?? 'default', apiKey: env.VITE_LLM_KEY })
  : new MockBrain()

const personas: Persona[] = [
  { name: 'Airi', description: 'A curious night-owl who loves reading and computers.', color: 0xff8fb8, sleepWindow: [1, 9], bed: 'bed' },
  { name: 'Luna', description: 'A cheerful, sociable early riser. Likes chatting, and also reading.', color: 0x8fd8ff, sleepWindow: [22, 6], bed: 'bed2' },
]
const startPos = [{ x: 0, z: 0 }, { x: -1.5, z: 1.5 }]
const agents = personas.map((p, i) => new Agent(p, startPos[i], brain, world))

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
camera.position.set(0, 9, 11)
camera.lookAt(0, 0.5, 0)

const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 0.6)
const sun = new THREE.DirectionalLight(0xffffff, 1.2)
sun.position.set(5, 10, 6)
sun.castShadow = true
scene.add(hemi, sun)

const mat = (c: number) => new THREE.MeshStandardMaterial({ color: c })
function box(w: number, h: number, d: number, color: number, x: number, y: number, z: number) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color))
  m.position.set(x, y, z)
  m.castShadow = m.receiveShadow = true
  scene.add(m)
  return m
}

const { w, d } = world.bounds
const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(0xc9b79c))
floor.rotation.x = -Math.PI / 2
floor.receiveShadow = true
scene.add(floor)
box(w, 3, 0.2, 0xe8e4dc, 0, 1.5, -d / 2)       // back wall
box(0.2, 3, d, 0xdcd8d0, -w / 2, 1.5, 0)       // left wall

// furniture (matches World objects)
box(2.2, 0.5, 1.4, 0x6a7fd1, -3.5, 0.25, -2.5) // bed
box(0.9, 0.2, 1.4, 0xffffff, -4.3, 0.55, -2.5) // pillow
box(2.2, 0.5, 1.4, 0xd16a8f, -3.5, 0.25, 0.4)   // bed2
box(0.9, 0.2, 1.4, 0xffffff, -4.3, 0.55, 0.4)   // pillow2
box(2.4, 0.1, 1.2, 0x8a6a4a, 3.5, 0.75, -3.4)  // desk top
box(0.6, 0.45, 0.05, 0x111111, 3.5, 1.05, -3.6) // monitor
box(0.6, 2.0, 2.6, 0x7a5636, 4.7, 1.0, 0.5)    // bookshelf
box(0.5, 0.5, 0.5, 0x555555, 3.5, 0.25, -2.2)   // chair

// avatars: capsule until a VRM loads
const avatars = agents.map(a => {
  const av = new Avatar(a.persona.color)
  scene.add(av.root)
  av.setName(a.name, a.persona.color)
  return av
})
// per-agent default models (public/model.vrm, public/model2.vrm); falls back to the capsule.
// Vite's SPA fallback serves HTML for missing files, so sniff the "glTF" magic.
const modelUrls = ['/model.vrm', '/model2.vrm']
modelUrls.forEach((u, i) => {
  if (!avatars[i]) return
  fetch(u).then(r => r.blob()).then(async b => {
    if ((await b.slice(0, 4).text()) !== 'glTF') return
    const url = URL.createObjectURL(b)
    await avatars[i].load(url).catch(e => console.warn('VRM load failed', e))
    URL.revokeObjectURL(url)
  })
})
// drag & drop a .vrm onto the page: it goes to the agent whose half of the screen you drop on
addEventListener('dragover', e => e.preventDefault())
addEventListener('drop', e => {
  e.preventDefault()
  const f = e.dataTransfer?.files[0]
  const i = Math.min(avatars.length - 1, Math.floor((e.clientX / innerWidth) * avatars.length))
  if (f && f.name.toLowerCase().endsWith('.vrm')) avatars[i].loadFile(f).catch(err => console.warn(err))
})

;(window as any).dbg = { world, agents, avatars, camera } // handy for console poking

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
const pathLines = agents.map(a => {
  const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: a.persona.color }))
  line.frustumCulled = false
  debug.add(line)
  return line
})

const hud = document.getElementById('hud')!
addEventListener('keydown', e => {
  if (e.key === 'g' || e.key === 'G') debug.visible = !debug.visible
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
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  const gameDt = world.advance(dt)
  agents.forEach(a => a.tick(dt, gameDt))

  // day/night
  const h = world.minutes / 60 % 24
  const daylight = Math.max(0, Math.sin(((h - 6) / 24) * Math.PI * 2))
  scene.background = nightColor.clone().lerp(dayColor, daylight)
  sun.intensity = 0.2 + daylight * 1.1
  hemi.intensity = 0.25 + daylight * 0.4

  agents.forEach((a, i) => avatars[i].update(dt, a))
  if (debug.visible) {
    agents.forEach((a, i) => {
      const pts = a.state.k === 'moving' ? [a.pos, ...a.state.path] : []
      pathLines[i].geometry.setFromPoints(pts.map(p => new THREE.Vector3(p.x, 0.08, p.z)))
    })
  }

  hud.textContent =
    `${world.clock}   speed x${world.speed} (1/2/3 speed, G nav debug)   brain: ${brain instanceof LLMBrain ? 'LLM' : 'mock'}\n` +
    (brain instanceof LLMBrain && brain.status ? `⚠ ${brain.status}\n` : '') + '\n' +
    agents.map(a => a.statusText + (a.memory.length ? '\n  ' + a.memory.slice(-3).join('\n  ') : '')).join('\n\n')

  renderer.render(scene, camera)
  labelRenderer.render(scene, camera)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
