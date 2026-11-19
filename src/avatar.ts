import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  VRM, VRMLoaderPlugin, VRMUtils, VRMSpringBoneCollider, VRMSpringBoneColliderShapeCapsule, VRMSpringBoneColliderShapePlane, VRMSpringBoneColliderShapeSphere,
  type VRMSpringBoneColliderGroup, type VRMSpringBoneJoint,
} from '@pixiv/three-vrm'
import { JUMP_AIR, JUMP_CROUCH, WALK_SPEED, type Agent } from './agent'
import type { Emotion, Gesture } from './acting'
import type { SkillMotion } from './skills'
import type { Physics } from './physics'
import { Drift, FidgetPicker, hash, seeded, styleFor, type MotionStyle } from './motion-style'
import { ClipPlayer, type MotionLibrary } from './clips'

/**
 * Visual body for an agent. Starts as a capsule, becomes a VRM once one loads.
 * Poses are procedural (no animation clips needed); swap for AnimationMixer clips later.
 */
export class Avatar {
  readonly root = new THREE.Group()    // world position + yaw
  private inner = new THREE.Group()    // pitch (lying down) + vertical offset
  private capsule: THREE.Mesh
  private vrm?: VRM
  /**
   * Hair, skirts and ribbons are spring bones that know nothing about the bed, so lying down they sag through
   * the mattress and the frame. While the avatar lies, this rounded slab (the top 0.5 m above the floor, like
   * the mattress and the cot) is added to every joint's collider groups so they rest on it instead.
   */
  private bedGroup?: VRMSpringBoneColliderGroup
  private bedCollider?: VRMSpringBoneCollider
  private bedShape?: VRMSpringBoneColliderShapeCapsule
  /** VRM 0.x rigs face -Z, so bone-local X and Z rotations are mirrored compared with VRM 1.0 */
  private v0 = false
  private hipsY = 0.9
  /** how far the hip joints are below the hips bone, and how thick the thigh is (its radius), from the model */
  private legBelowHips = 0.06
  private thighR = 0.07
  /** the toes' height standing, and how far the feet point down when seated (feetOnFloor) */
  private toeY = 0.02
  private footPoint = 0
  /** how far the back (and the back of the head) is behind the spine's line, from the model (lying down) */
  private backDepth = 0.12
  /** top of the bed under a lying avatar, from a physics ray (lieHeight) */
  private bedTop = 0.5
  /** blend weight of the hands resting on the thighs or the table while sitting idle */
  private restW = 0
  /** top of the seat under a sitting avatar, from a physics ray (sitHeight) */
  private seatTop = 0.46
  private walkP = 0
  /** how far the current gesture has blended in, 0..1, and which one it is (kept while it fades out) */
  private gestureW = 0
  private gestureNow: Gesture | SkillMotion | '' = ''
  /** whether the avatar's shoes are shown (they come off in bed, rule R1) */
  private shoesShown = true
  /** how far the hips are lowered because the knees bend (crouching for a jump), metres */
  private crouchDrop = 0
  /** current weight of each VRM expression preset that shows an emotion */
  private face: Record<FacePreset, number> = { happy: 0.05, sad: 0, angry: 0, surprised: 0, relaxed: 0 }
  private t = 0
  private yaw = 0
  private lookYaw = 0
  /** where the agent was last frame, to see whether the body covered ground */
  private lastPos: { x: number; z: number } | null = null
  private cur = { pitch: 0, y: 0, z: 0 }
  private nextFlip = 4
  private flip = 0
  private book = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.03, 0.32),
    new THREE.MeshStandardMaterial({ color: 0xe8d9a8 }),
  )
  /** a fishing rod with its line and bobber, in front of the avatar while fishing */
  private rod = new THREE.Group()
  private blinkT = 2
  private headTop = 1.7
  private label: CSS2DObject
  private nameEl = document.createElement('div')
  private sayEl = document.createElement('div')
  private thinkEl = document.createElement('div')
  private shown = { say: '', think: '' }
  /** this person's way of walking and standing, and its slow drift over time (motion-style.ts) */
  private readonly style: MotionStyle
  private readonly drift: { stride: Drift; arms: Drift; pace: Drift; lean: Drift; sway: Drift; head: Drift }
  private readonly fidgets = new FidgetPicker()
  /** motion clips (clips.ts), once both the library and the model have loaded */
  private motions?: MotionLibrary
  private clips?: ClipPlayer

  constructor(color: number, name = '') {
    this.style = styleFor(name)
    const rnd = seeded(hash(name) ^ 0x9E3779B9), r = this.style.drift
    this.drift = { stride: new Drift(rnd, r), arms: new Drift(rnd, r), pace: new Drift(rnd, r * 0.7), lean: new Drift(rnd, r * 0.5), sway: new Drift(rnd, r * 0.8), head: new Drift(rnd, r * 1.3) }
    this.capsule = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.3, 0.9, 6, 12),
      new THREE.MeshStandardMaterial({ color }),
    )
    this.capsule.position.y = 0.75
    this.capsule.castShadow = true
    this.inner.add(this.capsule)
    this.root.add(this.inner)
    this.book.visible = false
    this.root.add(this.book)
    const rodDir = new THREE.Vector3(0, 0.5, Math.sqrt(0.75))
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a33 })
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.022, 2.2, 6), wood)
    stick.rotation.x = Math.PI / 3                       // along rodDir
    stick.position.copy(rodDir).multiplyScalar(1.1)
    const tip = rodDir.clone().multiplyScalar(2.2)
    const lineLen = 1.0 + tip.y + 0.12                   // from the tip down to the water (about 0.12 m below the floor)
    const line = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, lineLen, 3), new THREE.MeshBasicMaterial({ color: 0xeeeeee }))
    line.position.set(0, tip.y - lineLen / 2, tip.z)
    const bobber = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshStandardMaterial({ color: 0xd9452f }))
    bobber.position.set(0, tip.y - lineLen, tip.z)
    this.rod.add(stick, line, bobber)
    this.rod.position.set(0.18, 1.0, 0.3)
    this.rod.visible = false
    this.root.add(this.rod)

    // floating label: name tag always, speech / thought bubbles when active
    const wrap = document.createElement('div')
    wrap.className = 'label'
    this.sayEl.className = 'bubble say'
    this.thinkEl.className = 'bubble think'
    this.nameEl.className = 'nametag'
    wrap.append(this.sayEl, this.thinkEl, this.nameEl)
    this.label = new CSS2DObject(wrap)
    this.label.position.y = this.headTop
    this.root.add(this.label)
  }

  setName(name: string, color: number) {
    this.nameEl.textContent = name
    this.nameEl.style.borderColor = '#' + color.toString(16).padStart(6, '0')
  }

  private updateLabel(agent: Agent, sit: boolean, lie: boolean, swim: boolean) {
    const now = performance.now()
    const say = agent.speech && now < agent.speechUntil ? agent.speech : ''
    const think = !say && agent.thought && now < agent.thoughtUntil ? agent.thought : ''
    if (say !== this.shown.say) {
      this.sayEl.textContent = say
      this.sayEl.classList.toggle('on', !!say)
      this.shown.say = say
    }
    if (think !== this.shown.think) {
      this.thinkEl.textContent = think
      this.thinkEl.classList.toggle('on', !!think)
      this.shown.think = think
    }
    // keep the label just above the head for the current pose
    const y = swim ? 0.7 : lie ? (this.vrm ? 1.0 : 1.35) : sit ? this.headTop - (this.hipsY - 0.55) : this.headTop
    this.label.position.y += (y - this.label.position.y) * 0.2
  }

  /** walk and stand with the motion clips in `lib` (clips.ts) */
  useMotions(lib: MotionLibrary) {
    this.motions = lib
    if (this.vrm) this.clips = new ClipPlayer(lib, this.vrm)
  }

  async load(url: string) {
    const loader = new GLTFLoader()
    loader.register(p => new VRMLoaderPlugin(p))
    const gltf = await loader.loadAsync(url)
    const vrm = gltf.userData.vrm as VRM | undefined
    if (!vrm) throw new Error('not a VRM file')
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    VRMUtils.rotateVRM0(vrm) // make VRM0 models face +Z like VRM1
    vrm.scene.traverse(o => { o.frustumCulled = false; (o as THREE.Mesh).castShadow = true })
    hideRoboParts(vrm.scene)

    if (this.vrm) { this.inner.remove(this.vrm.scene); VRMUtils.deepDispose(this.vrm.scene) }
    this.vrm = vrm
    this.clips = this.motions ? new ClipPlayer(this.motions, vrm) : undefined
    this.v0 = vrm.meta?.metaVersion === '0'
    this.capsule.visible = false
    this.inner.add(vrm.scene)

    // a big capsule lying along the bed (the avatar's local z while lying), its top at BED_TOP: a wide, shallow
    // curve, so what hangs over the side slides down beside the frame, and nothing is held up in mid air
    this.bedShape = new VRMSpringBoneColliderShapeCapsule({
      radius: BED_RADIUS,
      offset: new THREE.Vector3(0, BED_TOP - BED_RADIUS, -1.1),
      tail: new THREE.Vector3(0, BED_TOP - BED_RADIUS, 1.1),
    })
    const slab = new VRMSpringBoneCollider(this.bedShape)
    this.root.add(slab)
    this.bedCollider = slab
    this.bedGroup = { colliders: [slab], name: 'bed' }
    this.bedOn = false
    // hair and cloth hang down and settle: many VRoid models ship springs with no gravity and no drag, so the hair
    // floats and keeps swinging. Give every joint at least a little of both (the model's own values when higher).
    for (const j of vrm.springBoneManager?.joints ?? []) {
      const st = j.settings
      if (st.gravityDir.lengthSq() < 1e-6) st.gravityDir.set(0, -1, 0)
      st.gravityPower = Math.max(st.gravityPower, MIN_GRAVITY)
      st.dragForce = Math.max(st.dragForce, MIN_DRAG)
    }
    // the hair: spring joints under the head (lying down treats it differently, see layHair)
    const headBone = vrm.humanoid.getRawBoneNode('head')
    const underHead = (o: THREE.Object3D | null) => { for (let p = o?.parent; p; p = p.parent) if (p === headBone) return true; return false }
    this.hairDown = false
    this.hair = [...(vrm.springBoneManager?.joints ?? [])].filter(j => underHead(j.bone)).map(joint => ({
      joint, stiffness: joint.settings.stiffness, gravityPower: joint.settings.gravityPower,
      dragForce: joint.settings.dragForce, gravityDir: joint.settings.gravityDir.clone(),
    }))
    // furniture and walls near the hair and clothes: big spheres touching the surfaces that rays from the head and
    // the hips hit (see probeSurroundings), so they push only near that surface; plus the floor. Unused spheres
    // are parked far below.
    this.surfaces = SURFACE_DIRS.map(() => {
      const shape = new VRMSpringBoneColliderShapeSphere({ offset: new THREE.Vector3(0, PARKED, 0), radius: 0.01 })
      const collider = new VRMSpringBoneCollider(shape)
      this.root.add(collider)
      return { collider, shape }
    })
    this.floorShape = new VRMSpringBoneColliderShapePlane({ offset: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(0, 1, 0) })
    const floor = new VRMSpringBoneCollider(this.floorShape)
    this.root.add(floor)
    const surfaceGroup: VRMSpringBoneColliderGroup = { colliders: [...this.surfaces.map(x => x.collider), floor], name: 'surroundings' }
    for (const j of vrm.springBoneManager?.joints ?? []) j.colliderGroups.push(surfaceGroup)

    const hips = vrm.humanoid.getNormalizedBoneNode('hips')
    if (hips) {
      vrm.scene.updateMatrixWorld(true)
      this.hipsY = hips.getWorldPosition(new THREE.Vector3()).y
      const leg = vrm.humanoid.getNormalizedBoneNode('leftUpperLeg')
      if (leg) this.legBelowHips = this.hipsY - leg.getWorldPosition(new THREE.Vector3()).y
    }
    this.thighR = thighRadius(vrm)
    this.backDepth = backDepth(vrm)
    const toes = vrm.humanoid.getNormalizedBoneNode('leftToes')
    if (toes) this.toeY = toes.getWorldPosition(new THREE.Vector3()).y
    const head = this.bone('head')
    if (head) this.headTop = head.getWorldPosition(new THREE.Vector3()).y + 0.3
  }

  async loadFile(file: File) {
    const url = URL.createObjectURL(file)
    try { await this.load(url) } finally { URL.revokeObjectURL(url) }
  }

  private bone(name: Parameters<VRM['humanoid']['getNormalizedBoneNode']>[0]) {
    return this.vrm?.humanoid.getNormalizedBoneNode(name) ?? null
  }

  private tmpQ = new THREE.Quaternion()
  private tmpE = new THREE.Euler()
  /** Blend a bone toward a target rotation (radians, XYZ). */
  private pose(name: BoneName, k: number, x = 0, y = 0, z = 0) {
    const b = this.bone(name)
    if (!b) return
    const f = this.v0 ? -1 : 1
    this.tmpQ.setFromEuler(this.tmpE.set(x * f, y, z * f, 'XYZ'))
    b.quaternion.slerp(this.tmpQ, k)
  }

  update(dt: number, agent: Agent, physics?: Physics) {
    this.t += dt
    const t = this.t
    const now = performance.now()
    const st = agent.state
    // legs walk only while the agent actually covers ground (a walker waiting behind someone stands still)
    // (also stepping along while opening or closing the door, or on the frame a walk hands over to the next step;
    // not while sitting down or standing up, when the body moves with the legs folding)
    const stepping = st.k === 'routine' && st.steps[0]?.do === 'act' && agent.pose === 'stand'
    const posing = st.k === 'routine' && st.steps[0]?.do === 'pose'
    const covered = this.lastPos && dt > 0 ? Math.hypot(agent.pos.x - this.lastPos.x, agent.pos.z - this.lastPos.z) / dt : 0
    this.lastPos = { ...agent.pos }
    const glide = agent.pose === 'stand' && !posing && covered > 0.2 && covered < WALK_SPEED * 2
    const moving = ((st.k === 'moving' || st.k === 'chatting' || stepping) && agent.speedNow > 0.05) || glide
    const stride = Math.max(moving && !glide ? agent.speedNow : 0, glide ? covered : 0)
    const verb = st.k === 'doing' ? st.aff.verb : ''
    const sit = agent.pose === 'sit', lie = agent.pose === 'lie', swim = agent.pose === 'swim'
    const rise = agent.rise, recline = agent.recline
    const speaking = !!agent.speech && now < agent.speechUntil

    // smooth heading (shortest way round)
    let dy = agent.heading - this.yaw
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    this.yaw += dy * (1 - Math.exp(-dt * 10))
    this.root.position.set(agent.pos.x, agent.lift, agent.pos.z) // lift: in the air during a jump
    this.root.rotation.y = this.yaw
    this.updateLabel(agent, sit, lie, swim)
    this.rod.visible = verb === 'fish'

    if (!this.vrm) {
      // lying: tip the capsule onto its side and rest it on the mattress (top at ~0.5 m, radius 0.3),
      // otherwise its centre would sit at floor level, inside the bed
      this.inner.rotation.x = lie || swim ? Math.PI / 2 : 0
      this.inner.position.y = lie ? 0.82 : 0
      this.capsule.position.y = lie || swim ? 0 : sit ? 0.55 : 0.75
      return
    }

    const k = 1 - Math.exp(-dt * 12)        // pose blend rate
    const kSlow = 1 - Math.exp(-dt * 6)
    // about 0.9 strides per second at walking speed (this person's own pace, drifting a little), slower when the
    // agent slows down
    const ms = this.style, dr = this.drift
    const cadence = ms.cadence * (1 + 0.05 * dr.pace.at(t))
    if (moving) this.walkP += dt * cadence * Math.min(1.2, stride / WALK_SPEED) * (agent.walkBack ? -1 : 1)
    const p = this.walkP, s = Math.sin(p), c = Math.cos(p)
    const breath = Math.sin(t * 1.7)
    const P = (n: BoneName, x = 0, y = 0, z = 0, rate = k) => this.pose(n, rate, x, y, z)
    // bones only the motion clips move: back to rest when no clip plays, or they keep the clip's last pose
    // (lying down, shoulders still raised and rolled back put the arms under the body)
    for (const n of CLIP_ONLY) P(n)

    // ---- legs ----
    const sw = t * 3.4 // swimming stroke phase
    if (swim) {
      P('leftUpperLeg', Math.sin(sw * 2.4) * 0.35, 0, -0.03); P('rightUpperLeg', -Math.sin(sw * 2.4) * 0.35, 0, 0.03)
      P('leftLowerLeg', Math.max(0, -Math.sin(sw * 2.4)) * 0.5); P('rightLowerLeg', Math.max(0, Math.sin(sw * 2.4)) * 0.5)
      P('leftFoot', 0.3); P('rightFoot', 0.3)
    } else if (recline !== null) {
      // sitting up in bed or lying down: the thighs stay level on the bed while the back swings about the hips (see
      // the body placement below), so they bend at the hips by as much as the back is up; the knees bend over the
      // edge only in the second half, once the legs have turned out over it
      const knee = Math.min(1, Math.max(0, (recline - 0.4) / 0.6)), kn = knee * knee * (3 - 2 * knee)
      const th = recline * Math.PI / 2
      P('leftUpperLeg', -th, 0.1 * recline, -0.05 * recline, 1); P('rightUpperLeg', -th, -0.1 * recline, 0.05 * recline, 1)
      P('leftLowerLeg', (Math.PI / 2 - 0.1) * kn, 0, 0, 1); P('rightLowerLeg', (Math.PI / 2 - 0.1) * kn, 0, 0, 1)
      P('leftFoot', 0.1 * kn, 0, 0, 1); P('rightFoot', 0.1 * kn, 0, 0, 1)
    } else if (rise) {
      // sitting down or standing up: the thighs swing between level and upright about knees over the feet, the
      // shins stay upright, so the feet stay where they are (the agent moves the body to match, agent.ts)
      const down = 1 - rise.u, phi = down * Math.PI / 2
      P('leftUpperLeg', -phi, 0.1 * down, -0.05 * down, 1); P('rightUpperLeg', -phi, -0.1 * down, 0.05 * down, 1)
      P('leftLowerLeg', phi - 0.1 * down, 0, 0, 1); P('rightLowerLeg', phi - 0.1 * down, 0, 0, 1)
      P('leftFoot', (0.1 + this.footPoint) * down, 0, 0, 1); P('rightFoot', (0.1 + this.footPoint) * down, 0, 0, 1)
    } else if (sit) {
      P('leftUpperLeg', -Math.PI / 2, 0.1, -0.05); P('rightUpperLeg', -Math.PI / 2, -0.1, 0.05)
      P('leftLowerLeg', Math.PI / 2 - 0.1); P('rightLowerLeg', Math.PI / 2 - 0.1)
      // short legs on a high seat: the feet point down until the toes rest on the floor (footPoint)
      P('leftFoot', 0.1 + this.footPoint); P('rightFoot', 0.1 + this.footPoint)
    } else if (moving) {
      // this person's stride, a little longer or shorter from moment to moment
      const st = ms.stride * (1 + 0.12 * dr.stride.at(t)), kn = ms.knee * (1 + 0.1 * dr.stride.at(t + 7))
      P('leftUpperLeg', s * st); P('rightUpperLeg', -s * st)
      P('leftLowerLeg', Math.max(0, -c) * kn); P('rightLowerLeg', Math.max(0, c) * kn)
      P('leftFoot', -s * 0.25); P('rightFoot', s * 0.25)
    } else {
      P('leftUpperLeg', 0, 0, -0.03); P('rightUpperLeg', 0, 0, 0.03)
      P('leftLowerLeg'); P('rightLowerLeg'); P('leftFoot'); P('rightFoot')
    }

    // ---- torso, arms, by activity ----
    let headX = 0, headY = 0
    if (moving) {
      // this person's posture and arm swing, drifting a little so no two strides look the same
      const arm = ms.armSwing * (1 + 0.18 * dr.arms.at(t)), lean = ms.lean * (1 + 0.3 * dr.lean.at(t))
      P('hips', 0, -s * ms.twist, c * ms.hipDrop)
      P('spine', lean, s * ms.twist); P('chest', 0, s * ms.twist * 0.8); P('neck', -lean * 0.5)
      P('leftUpperArm', -s * arm, 0, -ms.armOut); P('rightUpperArm', s * arm, 0, ms.armOut)
      P('leftLowerArm', 0, -ms.elbow - Math.max(0, -s) * 0.3); P('rightLowerArm', 0, ms.elbow + Math.max(0, s) * 0.3)
      P('leftHand'); P('rightHand')
      headY = dr.head.at(t) * 0.12
    } else if (verb === 'use_computer') {
      const typeL = Math.sin(t * 17) * 0.06, typeR = Math.sin(t * 17 + 1.7) * 0.06
      P('hips'); P('spine', 0.12); P('chest', 0.05); P('neck', 0.08)
      P('leftUpperArm', TYPE_ARM.upX, 0, -TYPE_ARM.upZ); P('rightUpperArm', TYPE_ARM.upX, 0, TYPE_ARM.upZ)
      P('leftLowerArm', 0, -TYPE_ARM.lowY + typeL); P('rightLowerArm', 0, TYPE_ARM.lowY - typeR)
      P('leftHand', TYPE_ARM.handX + typeR, 0, 0); P('rightHand', TYPE_ARM.handX + typeL, 0, 0)
      headX = 0.12
    } else if (verb === 'read') {
      this.flip = Math.max(0, this.flip - dt * 3)
      if (t > this.nextFlip) { this.flip = 1; this.nextFlip = t + 5 + Math.random() * 4 }
      P('hips'); P('spine', 0.06); P('chest', 0.04); P('neck', 0.15)
      P('leftUpperArm', -0.85, 0, -1.0); P('rightUpperArm', -0.85, 0, 1.0)
      P('leftLowerArm', 0, -1.7); P('rightLowerArm', 0, 1.7 - this.flip * 0.25)
      P('leftHand', 0, 0, 0); P('rightHand', 0, 0, this.flip * 0.3)
      headX = 0.3
    } else if (verb === 'boat') {
      // rowing: lean in and out with the oars, arms pulling and pushing together
      const r = Math.sin(t * 2.6)
      P('hips'); P('spine', 0.1 + r * 0.12); P('chest', 0.04); P('neck')
      P('leftUpperArm', -0.6 + r * 0.5, 0, -0.9); P('rightUpperArm', -0.6 + r * 0.5, 0, 0.9)
      P('leftLowerArm', 0, -(1.0 - r * 0.5)); P('rightLowerArm', 0, 1.0 - r * 0.5)
      P('leftHand'); P('rightHand')
      headX = 0.05
    } else if (swim) {
      // front crawl: the arms reach forward over the head and pull back, one after the other
      P('hips'); P('spine', 0, Math.sin(sw) * 0.12); P('chest', 0, Math.sin(sw) * 0.1); P('neck')
      P('leftUpperArm', 1.9 + Math.sin(sw) * 1.1, 0, -1.0); P('rightUpperArm', 1.9 - Math.sin(sw) * 1.1, 0, 1.0)
      P('leftLowerArm', 0, -0.25 - Math.max(0, Math.cos(sw)) * 0.7); P('rightLowerArm', 0, 0.25 + Math.max(0, -Math.cos(sw)) * 0.7)
      P('leftHand'); P('rightHand')
      headX = -0.9
      headY = Math.sin(sw * 0.5) * 0.15
    } else if (lie) {
      // breathing bends the back only forward (up, lying on it), never back into the mattress
      const lift = (1 + breath) / 2
      P('hips'); P('spine', 0.02 * lift); P('chest', 0.03 * lift); P('neck')
      P('leftUpperArm', 0, 0, -1.4); P('rightUpperArm', 0, 0, 1.4)
      P('leftLowerArm', 0, -0.25); P('rightLowerArm', 0, 0.25)
      P('leftHand'); P('rightHand')
      headY = 0.25
    } else if (sit) {
      // sitting idle (sofa, dining seat): hands rest on the thighs, so they stay out of the seat cushion
      P('hips'); P('spine', 0.04 + 0.015 * breath); P('chest', 0.02 * breath); P('neck')
      P('leftUpperArm', SIT_ARM.upX, 0, -SIT_ARM.upZ); P('rightUpperArm', SIT_ARM.upX, 0, SIT_ARM.upZ)
      P('leftLowerArm', 0, -SIT_ARM.lowY); P('rightLowerArm', 0, SIT_ARM.lowY)
      P('leftHand', SIT_ARM.handX); P('rightHand', SIT_ARM.handX)
      if (speaking) {
        // talk with the right hand, held high enough to clear a table in front
        P('rightUpperArm', SIT_TALK.upX + Math.sin(t * 4.5) * 0.15, 0, SIT_TALK.upZ)
        P('rightLowerArm', 0, SIT_TALK.lowY + Math.sin(t * 6.3) * 0.3)
        P('rightHand', 0, 0, Math.sin(t * 6.3 + 1) * 0.2)
      }
    } else {
      // standing idle: breathing, this person's slow weight shift, and now and then a small idle movement
      const fid = !speaking && !(agent.gesture && now < agent.gestureUntil) ? this.fidgets.update(t) : (this.fidgets.reset(t), null)
      // fidgets ease in and out
      const env = fid ? Math.min(1, fid.u / 0.25, (1 - fid.u) / 0.25) : 0, ease = env * env * (3 - 2 * env)
      const shift = fid?.kind === 'shift' ? fid.side * ease : 0
      const roll = fid?.kind === 'roll_shoulders' ? Math.sin(fid.u * Math.PI * 2) * ease : 0
      P('hips', 0, 0, dr.sway.at(t) * ms.idleSway + shift * 0.05)
      P('spine', 0.015 * breath, 0, -shift * 0.03); P('chest', 0.02 * breath + roll * 0.04)
      P('neck', 0, 0, fid?.kind === 'stretch_neck' ? fid.side * Math.sin(fid.u * Math.PI) * 0.3 : 0)
      // the relaxed leg bends a little while the weight is on the other one
      if (shift) P(shift > 0 ? 'rightLowerLeg' : 'leftLowerLeg', Math.abs(shift) * 0.18)
      P('leftUpperArm', 0.02 * breath, 0, -1.3 + 0.015 * breath - roll * 0.1); P('rightUpperArm', 0.02 * breath, 0, 1.3 - 0.015 * breath + roll * 0.1)
      P('leftLowerArm', 0, -0.2); P('rightLowerArm', 0, 0.2)
      P('leftHand'); P('rightHand')
      headY = dr.head.at(t) * 0.08 + (fid?.kind === 'look' ? fid.side * 0.6 * ease : 0)
      headX = fid?.kind === 'glance_down' ? 0.35 * ease : fid?.kind === 'look' ? -0.05 * ease : 0
      if (speaking) {
        // talk with the right hand
        P('rightUpperArm', -0.7 + Math.sin(t * 4.5) * 0.15, 0, 1.0)
        P('rightLowerArm', 0, 1.2 + Math.sin(t * 6.3) * 0.3)
        P('rightHand', 0, 0, Math.sin(t * 6.3 + 1) * 0.2)
      }
    }
    // ---- motion clips (clips.ts): walking, and standing about while not talking, from captured motion; the
    // pose above blends into the clip, and everything below goes on top of it ----
    // getting up or sitting down leans the body forward over the feet, most as the hips leave the seat (eased in,
    // so a bend left from a gesture before it, such as putting the shoes on, unwinds instead of snapping back)
    if (rise) P('spine', 0.45 * Math.sin(rise.u * Math.PI))
    const idleStand = !moving && !posing && !sit && !lie && !swim && verb !== 'use_computer' && verb !== 'read' && !speaking
    const clipKind = moving && agent.pose === 'stand' ? 'walk' : idleStand ? 'idle' : null
    const clipRate = clipKind === 'walk'
      ? stride / (this.clips?.clipSpeed() || WALK_SPEED) * (1 + 0.05 * dr.pace.at(t)) * (agent.walkBack ? -1 : 1)
      : 1 + 0.08 * dr.pace.at(t)
    this.clips?.update(dt, clipKind, clipRate)
    // ---- gestures (acting.ts): blended on their own weight, so they fully replace the pose above while they
    // play and fade back out at the end, instead of settling halfway between two targets ----
    const playing = agent.gesture && now < agent.gestureUntil && !lie && !swim ? agent.gesture : ''
    if (playing) this.gestureNow = playing
    // in over about 0.3 s, out over about 0.6 s: a movement ends by settling, not by springing back
    this.gestureW += ((playing ? 1 : 0) - this.gestureW) * (1 - Math.exp(-dt * (playing ? 9 : 5)))
    const gw = this.gestureW > 0.01 ? this.gestureW : 0
    const gElapsed = (now - agent.gestureStart) / 1000
    const gu = Math.min(1, Math.max(0, (now - agent.gestureStart) / Math.max(1, agent.gestureUntil - agent.gestureStart)))
    let crouch = 0
    if (gw && this.gestureNow) crouch = this.bodyGesture(this.gestureNow, gu, gElapsed, t, gw, P, sit)
    // ---- hands on things (agent.reach: a door handle, or the feet): two-bone IK on the arms ----
    const reachTo = agent.reach
    if (reachTo) this.reachAt = reachTo === 'feet' ? 'feet' : new THREE.Vector3(reachTo.x, reachTo.y, reachTo.z)
    this.reachW += ((reachTo ? 1 : 0) - this.reachW) * (1 - Math.exp(-dt * 10))
    if (this.reachW > 0.01 && this.reachAt) this.reachHands(this.reachAt, this.reachW, dt)
    else this.footAt = null
    // sitting idle (not typing or reading, not acting, not talking with the hands): hands rest on something
    const resting = sit && !playing && !reachTo && !speaking && verb !== 'use_computer' && verb !== 'read'
    this.restW += ((resting ? 1 : 0) - this.restW) * (1 - Math.exp(-dt * 6))
    if (this.restW > 0.01) this.restHands(agent, verb, physics, this.restW)
    // fingers: relaxed curl
    for (const side of ['left', 'right'] as const) {
      const sign = side === 'left' ? -1 : 1
      for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
        const curl = (verb === 'read' ? 0.5 : 0.28) * sign
        P(`${side}${f}Proximal` as BoneName, 0, 0, curl); P(`${side}${f}Intermediate` as BoneName, 0, 0, curl * 1.2)
      }
    }

    // ---- head: look at someone nearby, nod while talking ----
    let want = 0
    if (!lie && !swim) {
      const other = agent.nearestOther(3.5)
      if (other) {
        let a = Math.atan2(other.pos.x - agent.pos.x, other.pos.z - agent.pos.z) - this.yaw
        a = Math.atan2(Math.sin(a), Math.cos(a))
        // someone behind: look ahead, or the head flips from one shoulder to the other as they cross behind
        want = Math.abs(a) > LOOK_BEHIND ? 0 : Math.max(-1.0, Math.min(1.0, a))
      }
    }
    this.lookYaw += (want - this.lookYaw) * kSlow
    const nod = speaking ? Math.sin(t * 7) * 0.05 + 0.03 : 0
    P('head', headX + nod, headY + this.lookYaw * 0.6)
    P('neck', headX * 0.3, this.lookYaw * 0.3, 0, k)
    if (gw && this.gestureNow) this.headGesture(this.gestureNow, gu, gw, P)

    // ---- body placement (blended so sitting down / lying down is not a snap) ----
    // swimming: face down (the opposite pitch), half sunk into the water, which is 0.12 m below the floor
    const tgtPitch = lie ? -Math.PI / 2 : swim ? Math.PI / 2 : 0
    // sitting: the hips go as high as this model's thighs need to rest on top of the seat, not sink into it (R0)
    // lying: the back rests on the mattress, not in it, however deep this model's back is (R0)
    const tgtY = lie ? this.lieHeight(agent, physics) : swim ? -0.08 + Math.sin(t * 2) * 0.02 : sit ? this.sitHeight(agent, physics) - this.hipsY : 0
    // lying pivots about the feet, so slide the body along its length to centre the hips on the bed
    const tgtZ = lie ? this.hipsY * 0.95 : swim ? -this.hipsY * 0.95 : sit ? -0.12 : 0
    const kp = 1 - Math.exp(-dt * 7)
    if (recline !== null) {
      // sitting up or lying down: the back swings about the hips, which go straight from where they lie to where
      // they sit (the body pivots about the feet, so take the pitch's own lift and shift back out)
      const p = -Math.PI / 2 * (1 - recline), h = this.hipsY
      const lieY = this.lieHeight(agent, physics), sitY = this.sitHeight(agent, physics) - h
      const lieZ = h * 0.95 - h, sitZ = -0.12
      this.cur.pitch = p
      this.cur.y = lieY + (sitY + h - lieY) * recline - h * Math.cos(p)
      this.cur.z = lieZ + (sitZ - lieZ) * recline - h * Math.sin(p)
    } else if (rise) {
      // the hips rise with the thighs' swing (the sine of it), straight from the seat's height, not eased behind
      this.cur.pitch += (tgtPitch - this.cur.pitch) * kp
      this.cur.y = (this.sitHeight(agent, physics) - this.hipsY) * (1 - Math.sin(rise.u * Math.PI / 2))
      this.cur.z = -0.12 * (1 - rise.u)
    } else {
      this.cur.pitch += (tgtPitch - this.cur.pitch) * kp
      this.cur.y += (tgtY - this.cur.y) * kp
      this.cur.z += (tgtZ - this.cur.z) * kp
    }
    this.inner.rotation.x = this.cur.pitch
    // bent knees lower the hips by the height the legs lose, so the feet stay on the ground (see bodyGesture)
    this.crouchDrop += (this.legDrop(crouch) - this.crouchDrop) * (1 - Math.exp(-dt * 20))
    this.inner.position.set(0, this.cur.y - this.crouchDrop, this.cur.z)
    const hips = this.bone('hips')
    if (hips) {
      const own = this.hipsY + (moving ? Math.abs(c) * ms.bounce : Math.sin(t * 1.7) * 0.003)
      const clipY = this.clips?.hipsY()
      hips.position.y = clipY != null && this.clips ? own + (clipY - own) * this.clips.weight : own
    }

    // book prop in the hands while reading
    this.book.visible = verb === 'read'
    if (this.book.visible) {
      this.book.position.set(0, this.headTop * 0.7, 0.3)
      this.book.rotation.set(-0.9, 0, 0)
    }

    // ---- face ----
    this.blinkT -= dt
    const em = this.vrm.expressionManager
    if (em) {
      const phase = this.blinkT < 0 ? Math.max(0, 1 - Math.abs(this.blinkT) / 0.08) : 0
      em.setValue('blink', lie ? 1 : phase)
      if (this.blinkT < -0.16) this.blinkT = 2 + Math.random() * 3
      // emotion from acting (a tag or an "emotion" key), else a light smile while talking
      const feeling: Emotion = agent.emotion !== 'neutral' && now < agent.emotionUntil ? agent.emotion : speaking ? 'happy' : 'neutral'
      const want = lie ? SLEEP_FACE : feeling === 'happy' && !(agent.emotionUntil > now) ? TALK_FACE : EMOTION_FACE[feeling]
      const kf = 1 - Math.exp(-dt * 7)
      for (const p of FACE_PRESETS) {
        this.face[p] += ((want[p] ?? 0) - this.face[p]) * kf
        em.setValue(p, this.face[p])
      }
      em.setValue('aa', speaking ? Math.max(0, 0.25 + Math.sin(t * 14) * 0.25 + Math.sin(t * 9.3) * 0.15) : 0)
    }
    this.setBedCollision(lie || recline !== null)
    this.layHair(lie || (recline !== null && recline < 0.5))
    this.showShoes(agent.shoesOn)
    this.probeSurroundings(dt, agent, physics)
    this.feetOnFloor(dt, sit)
    this.vrm.update(dt)
  }

  /**
   * Arms, legs and torso of a gesture (`u` = 0..1 through it, `sec` = seconds since it started). Returns how far
   * the knees bend (0..1) so the hips can be lowered to keep the feet on the ground.
   */
  private bodyGesture(g: Gesture | SkillMotion, u: number, sec: number, t: number, w: number, P: PoseFn, sit: boolean): number {
    // arm poses are written for the right side; the left side mirrors y and z
    const arm = (side: 1 | -1, up: V3, low: V3, hand: V3 = [0, 0, 0]) => {
      const n = side > 0 ? 'right' : 'left', m = (v: V3): V3 => [v[0], v[1] * side, v[2] * side]
      P(`${n}UpperArm` as BoneName, ...m(up), w); P(`${n}LowerArm` as BoneName, ...m(low), w); P(`${n}Hand` as BoneName, ...m(hand), w)
    }
    const swing = Math.sin(t * 10) * 0.3
    switch (g) {
      case 'wave_right': case 'wave_left':
        arm(g === 'wave_right' ? 1 : -1, [0, 0, -0.25], [0, 0, -1.45 + swing], [0, 0, swing * 0.5]); return 0
      case 'raise_right_hand': case 'raise_left_hand':
        arm(g === 'raise_right_hand' ? 1 : -1, [-0.1, 0, -1.3], [0, 0, -0.15]); return 0
      case 'raise_right_leg': case 'raise_left_leg': {
        if (sit) return 0
        const n = g === 'raise_right_leg' ? 'right' : 'left'
        const lift = Math.sin(Math.min(1, u * 2.5) * Math.PI / 2)
        P(`${n}UpperLeg` as BoneName, -1.2 * lift, 0, 0, w); P(`${n}LowerLeg` as BoneName, 1.1 * lift, 0, 0, w); P(`${n}Foot` as BoneName, 0.3 * lift, 0, 0, w)
        arm(1, [0, 0, 0.9], [0, 0.2, 0]); arm(-1, [0, 0, 0.9], [0, 0.2, 0])      // arms out a little, for balance
        return 0
      }
      case 'bow': {
        const b = Math.sin(Math.min(1, u * 1.6) * Math.PI)   // down and back up
        P('spine', 0.45 * b, 0, 0, w); P('chest', 0.35 * b, 0, 0, w)
        arm(1, [0, 0, 1.35], [0, 0.1, 0]); arm(-1, [0, 0, 1.35], [0, 0.1, 0])
        return 0
      }
      case 'stretch':
        P('spine', -0.1, 0, 0, w); P('chest', -0.08, 0, 0, w)
        arm(1, [0, 0, -1.35], [0, 0, -0.1]); arm(-1, [0, 0, -1.35], [0, 0, -0.1])
        return 0
      case 'clap': {
        // arms forward, forearms swinging in until the hands meet in front of the chest
        const c = Math.abs(Math.sin(t * 9)) * 0.4
        arm(1, [0, 1.45, 0.5], [0, 1.05 + c, 0]); arm(-1, [0, 1.45, 0.5], [0, 1.05 + c, 0])
        return 0
      }
      case 'point':
        arm(1, [0.15, 1.57, -0.1], [0, 0, 0]); return 0                       // straight ahead at shoulder height
      case 'shrug':
        P('rightShoulder', 0, 0, -0.18, w); P('leftShoulder', 0, 0, 0.18, w)
        arm(1, [0, 0, 1.05], [0, 1.3, 0]); arm(-1, [0, 0, 1.05], [0, 1.3, 0])
        return 0
      case 'cheer': {
        const pump = Math.sin(t * 8) * 0.1
        arm(1, [-0.15, 0, -0.95 + pump], [0, 0, -0.2]); arm(-1, [-0.15, 0, -0.95 + pump], [0, 0, -0.2])
        return 0
      }
      case 'think':
        arm(1, [-0.7, 0.6, 1.3], [0, 2.4, 0], [0.3, 0, 0]); arm(-1, [-0.3, 0, 1.2], [0, 1.6, 0])   // hand to the chin
        return 0
      // ---- skill motions (skills/) ----
      case 'reach_handle':                  // the right hand goes out to the door handle at waist height
        arm(1, [0.1, 1.35, 0.5], [0, 0.25, 0]); return 0
      case 'push_door':                     // arm out, leaning a little into the door as it opens
        P('spine', 0.08, 0, 0, w)
        arm(1, [0.1, 1.4, 0.35 - 0.1 * u], [0, 0.1, 0]); return 0
      case 'pull_door':                     // hand on the handle, the elbow bending as the door comes
        P('spine', -0.04, 0, 0, w)
        arm(1, [0.1, 1.35, 0.45], [0, 0.2 + 0.9 * u, 0]); return 0
      case 'move_chair': {                  // a hand on the chair's top, bending down to a low one (a stool)
        if (sit) { P('spine', 0.08, 0, 0, w); return 0 } // seated: sliding in or out with the chair
        // bend down only while the hand is on the chair (reachAt is kept after the reach, for its fade-out)
        const on = this.reachAt instanceof THREE.Vector3 ? this.reachW : 0
        const low = this.reachAt instanceof THREE.Vector3 ? Math.min(1, Math.max(0, (1.0 - this.reachAt.y) / 0.5)) * on : 0
        const crouch = 0.5 * low
        // only a crouch moves the legs: fading out into standing up, straight legs would pull the feet in
        if (crouch > 0.01) for (const n of ['left', 'right'] as const) {
          P(`${n}UpperLeg` as BoneName, -0.6 * crouch, 0, 0, w); P(`${n}LowerLeg` as BoneName, 1.2 * crouch, 0, 0, w)
          P(`${n}Foot` as BoneName, -0.6 * crouch, 0, 0, w)
        }
        P('spine', 0.1 + 0.35 * low, 0, 0, w); P('chest', 0.12 * low, 0, 0, w)
        return crouch
      }
      case 'shoes': {                       // seated: lift one foot, then the other, and bend down to it
        const first = u < 0.5, f = first ? u * 2 : (u - 0.5) * 2
        const lift = Math.min(1, f / 0.25, (1 - f) / 0.25)
        this.shoesFoot = first ? 'right' : 'left'
        const n = this.shoesFoot
        const side = n === 'right' ? 1 : -1
        P(`${n}UpperLeg` as BoneName, -Math.PI / 2 - SHOE_LIFT.thigh * lift, SHOE_LIFT.twist * lift * side, SHOE_LIFT.out * lift * side, w)
        P(`${n}LowerLeg` as BoneName, Math.PI / 2 - 0.1 + SHOE_LIFT.knee * lift, 0, 0, w)
        P(`${n}Foot` as BoneName, 0.3 * lift, 0, 0, w)
        // bend down over the first half second and come back up over the last, not in a few frames
        const b = Math.min(1, u / 0.15, (1 - u) / 0.15), bend = b * b * (3 - 2 * b)
        P('spine', SHOE_LIFT.spine * bend, 0, 0, w); P('chest', SHOE_LIFT.chest * bend, 0, 0, w)
        arm(1, [-0.9, 0, 1.15], [0, 0.3, 0]); arm(-1, [-0.9, 0, 1.15], [0, 0.3, 0])
        return 0
      }
      case 'jump': {
        if (sit) return 0
        // crouch, fly (legs tucked a little, arms up), land and straighten
        const air = sec > JUMP_CROUCH && sec < JUMP_CROUCH + JUMP_AIR
        const crouch = sec <= JUMP_CROUCH ? Math.sin((sec / JUMP_CROUCH) * Math.PI / 2)
          : air ? 0.25 : Math.max(0, 0.8 * (1 - (sec - JUMP_CROUCH - JUMP_AIR) / 0.25))
        for (const n of ['left', 'right'] as const) {
          P(`${n}UpperLeg` as BoneName, -0.6 * crouch, 0, 0, w); P(`${n}LowerLeg` as BoneName, 1.2 * crouch, 0, 0, w)
          P(`${n}Foot` as BoneName, -0.6 * crouch + (air ? 0.4 : 0), 0, 0, w)
        }
        P('spine', 0.25 * crouch, 0, 0, w)
        if (air) { arm(1, [-0.3, 0, -0.6], [0, 0, -0.2]); arm(-1, [-0.3, 0, -0.6], [0, 0, -0.2]) }
        else { arm(1, [0.4 * crouch, 0, 1.2], [0, 0.3, 0]); arm(-1, [0.4 * crouch, 0, 1.2], [0, 0.3, 0]) }
        return air ? 0 : crouch
      }
      default:
        return 0
    }
  }

  /** head part of a gesture, applied after the look-at so it is not overridden */
  private headGesture(g: Gesture | SkillMotion, u: number, w: number, P: PoseFn) {
    switch (g) {
      case 'nod': P('head', 0.28 * Math.max(0, Math.sin(u * Math.PI * 4)), 0, 0, w); break
      case 'shake_head': P('head', 0, 0.45 * Math.sin(u * Math.PI * 4) * Math.sin(u * Math.PI), 0, w); break
      case 'bow': P('head', 0.2 * Math.sin(Math.min(1, u * 1.6) * Math.PI), 0, 0, w); break
      case 'stretch': P('head', -0.25, 0, 0, w); break
      case 'think': P('head', 0.12, 0, 0.14, w); break
      case 'shrug': P('head', 0, 0, 0.12, w); break
      case 'cheer': P('head', -0.15, 0, 0, w); break
      case 'shoes': P('head', 0.35, 0, 0, w); break
      case 'reach_handle': case 'pull_door': case 'push_door': case 'move_chair': P('head', 0.12, 0, 0, w); break
    }
  }

  /**
   * How much lower the hips must be when both knees bend by `crouch` (0..1 of the jump crouch), so the feet stay
   * on the ground: thigh and shin each lose height as they tilt (leg lengths taken from the hips' height).
   */
  private legDrop(crouch: number) {
    if (crouch <= 0) return 0
    const leg = this.hipsY / 2, a = 0.6 * crouch, b = 1.2 * crouch
    return leg * (1 - Math.cos(a)) + leg * (1 - Math.cos(a - b))
  }

  /**
   * Seated, the thighs lie on the seat; if the legs are too short for the soles to reach the floor, the feet point
   * down until the toes rest on it (from how high the toes are above the floor), as short people sit.
   */
  private feetOnFloor(dt: number, sit: boolean) {
    if (!sit) { this.footPoint += (0 - this.footPoint) * Math.min(1, dt * 8); return }
    const l = this.bone('leftToes') ?? this.bone('leftFoot'), r = this.bone('rightToes') ?? this.bone('rightFoot')
    if (!l || !r || this.gestureW > 0.5) return
    // the toe joint stops a little above its standing height: pointed down, the tips reach lower than the joint
    const above = Math.min(l.getWorldPosition(new THREE.Vector3()).y, r.getWorldPosition(new THREE.Vector3()).y) - this.toeY - 0.025
    this.footPoint = Math.max(0, Math.min(0.9, this.footPoint + above * dt * 25))
  }

  /** the body's height lying on whatever is under the avatar: the bed's top plus this model's back */
  private lieHeight(agent: Agent, physics?: Physics) {
    // under the hips and under the head (a pillow is higher than the mattress), whichever is higher
    const head = this.bone('head')?.getWorldPosition(new THREE.Vector3())
    const under = [agent.pos, ...(head ? [{ x: head.x, z: head.z }] : [])]
      .map(p => physics?.hit({ x: p.x, y: 1.3, z: p.z }, { x: 0, y: -1, z: 0 }, 1.3, agent.name)?.point.y)
      .filter((y): y is number => y !== undefined && y > 0.2 && y < 0.9)
    if (under.length) this.bedTop = Math.max(...under)
    return this.bedTop + this.backDepth + 0.01
  }

  /**
   * Sitting idle, the hands rest somewhere real: on the table in front while eating, if there is one within reach,
   * otherwise on the thighs. Placed by IK, so they lie on top of things whatever the model's proportions (R0).
   */
  private restHands(agent: Agent, verb: string, physics: Physics | undefined, w: number) {
    if (!this.vrm) return
    this.root.updateMatrixWorld(true)
    const rq = this.root.getWorldQuaternion(new THREE.Quaternion())
    const left = new THREE.Vector3(1, 0, 0).applyQuaternion(rq), fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(rq)
    const down = new THREE.Vector3(0, -1, 0)
    const hips = this.bone('hips')?.getWorldPosition(new THREE.Vector3())
    if (!hips) return
    if (verb === 'eat' && physics) {
      const ahead = hips.clone().addScaledVector(fwd, 0.38)
      const top = physics.hit({ x: ahead.x, y: hips.y + 0.6, z: ahead.z }, { x: 0, y: -1, z: 0 }, 0.6, agent.name)
      if (top && top.point.y > hips.y + 0.05 && top.point.y < hips.y + 0.45) {
        for (const side of ['left', 'right'] as const) {
          const s = side === 'left' ? 1 : -1
          const at = ahead.clone().setY(top.point.y + 0.065).addScaledVector(left, s * 0.14)
          // elbows out to the sides, not down through the table's edge; the hands lie flat on it
          this.ik(side, at, left.clone().multiplyScalar(s).add(new THREE.Vector3(0, 0.3, 0)), w)
          this.levelHand(side, w)
        }
        return
      }
    }
    for (const side of ['left', 'right'] as const) {
      const up = this.bone(`${side}UpperLeg` as BoneName), knee = this.bone(`${side}LowerLeg` as BoneName)
      if (!up || !knee) continue
      const s = side === 'left' ? 1 : -1
      const at = up.getWorldPosition(new THREE.Vector3()).lerp(knee.getWorldPosition(new THREE.Vector3()), 0.6)
        .add(new THREE.Vector3(0, this.thighR + 0.035, 0)).addScaledVector(left, s * 0.03)
      this.ik(side, at, left.clone().multiplyScalar(s).add(down).addScaledVector(fwd, -0.3), w)
      this.levelHand(side, w)
    }
  }

  /** turn the hand so the fingers point level, not down into what it rests on */
  private levelHand(side: 'left' | 'right', w: number) {
    const h = this.vrm!.humanoid
    const hand = h.getNormalizedBoneNode(`${side}Hand`), finger = h.getNormalizedBoneNode(`${side}MiddleProximal`)
    if (!hand || !finger || !hand.parent) return
    hand.updateWorldMatrix(true, false)
    const hq = hand.getWorldQuaternion(new THREE.Quaternion())
    const dir = finger.position.clone().normalize().applyQuaternion(hq)
    const level = dir.clone().setY(0)
    if (level.lengthSq() < 1e-4) return
    const wq = new THREE.Quaternion().setFromUnitVectors(dir, level.normalize()).multiply(hq)
    const pq = hand.parent.getWorldQuaternion(new THREE.Quaternion())
    hand.quaternion.slerp(pq.invert().multiply(wq), w)
    hand.updateWorldMatrix(false, true)
  }

  /** the hips' height for sitting on whatever is under the avatar: the seat's top plus this model's thigh */
  private sitHeight(agent: Agent, physics?: Physics) {
    // sitting down or getting up, the body is beside the seat: look for the seat under its use point
    const at = agent.rise?.seat ?? agent.pos
    const hit = physics?.hit({ x: at.x, y: 1.3, z: at.z }, { x: 0, y: -1, z: 0 }, 1.3, agent.name)
    if (hit && hit.point.y > 0.2) this.seatTop = hit.point.y
    return Math.max(0.5, this.seatTop + this.thighR + 0.01 + this.legBelowHips)
  }

  /** where the hands are reaching (kept while the reach fades out), its blend weight, and which foot */
  private reachAt: THREE.Vector3 | 'feet' | null = null
  private reachW = 0
  private shoesFoot: 'left' | 'right' = 'right'
  /** where the hands are on the feet, following the foot being worked on */
  private footAt: THREE.Vector3 | null = null

  /**
   * Put a hand on `at` (the hand on that side of the body), or both hands on the foot being worked on. The arm
   * poses above stay as a fallback; the IK result blends over them with weight `w`.
   */
  private reachHands(at: THREE.Vector3 | 'feet', w: number, dt: number) {
    if (!this.vrm) return
    this.root.updateMatrixWorld(true)
    const rq = this.root.getWorldQuaternion(new THREE.Quaternion())
    // the avatar's own axes in the world: x to its left, z forward
    const left = new THREE.Vector3(1, 0, 0).applyQuaternion(rq), down = new THREE.Vector3(0, -1, 0)
    if (at === 'feet') {
      const foot = this.bone(`${this.shoesFoot}Foot` as BoneName)
      if (!foot) return
      // the hands move over to the other foot, rather than jump to it
      const f = foot.getWorldPosition(new THREE.Vector3())
      this.footAt = this.footAt ? this.footAt.lerp(f, 1 - Math.exp(-dt * 10)) : f
      f.copy(this.footAt)
      // one hand each side of the foot, elbows out to the sides and forward, clear of the seat's edge
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(rq)
      this.ik('right', f.clone().addScaledVector(left, -0.06).add(new THREE.Vector3(0, 0.05, 0)), left.clone().negate().addScaledVector(fwd, 0.5), w)
      this.ik('left', f.clone().addScaledVector(left, 0.06).add(new THREE.Vector3(0, 0.05, 0)), left.clone().addScaledVector(fwd, 0.5), w)
      return
    }
    const local = this.root.worldToLocal(at.clone())
    const side = local.x < 0 ? 'right' : 'left'
    const out = side === 'right' ? left.clone().negate() : left.clone()
    const back = new THREE.Vector3(0, 0, -1).applyQuaternion(rq)
    // the palm, not the wrist, goes on the handle: aim the wrist a hand's length short of it
    const shoulder = this.bone(`${side}UpperArm` as BoneName)?.getWorldPosition(new THREE.Vector3())
    const wrist = shoulder ? at.clone().addScaledVector(at.clone().sub(shoulder).normalize(), -HAND_LEN) : at
    this.ik(side, wrist, out.multiplyScalar(0.5).add(down).addScaledVector(back, 0.3), w)
  }

  /**
   * Two-bone IK on one arm (normalised bones, whose rest pose has no rotation): the wrist goes to `target`, as far
   * as the arm reaches, with the elbow bent towards `pole`.
   */
  private ik(side: 'left' | 'right', target: THREE.Vector3, pole: THREE.Vector3, w: number) {
    const h = this.vrm!.humanoid
    const up = h.getNormalizedBoneNode(`${side}UpperArm`), lo = h.getNormalizedBoneNode(`${side}LowerArm`), hand = h.getNormalizedBoneNode(`${side}Hand`)
    if (!up || !lo || !hand || !up.parent) return
    up.parent.updateWorldMatrix(true, true)
    const S = up.getWorldPosition(new THREE.Vector3())
    const l1 = lo.position.length(), l2 = hand.position.length()
    const toT = target.clone().sub(S)
    const d = Math.min(Math.max(toT.length(), 0.02), (l1 + l2) * 0.999)
    const dir = toT.normalize()
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), bend = Math.sqrt(Math.max(0, l1 * l1 - a * a))
    const perp = pole.clone().addScaledVector(dir, -pole.dot(dir))
    if (perp.lengthSq() < 1e-6) perp.set(0, -1, 0)
    perp.normalize()
    const elbow = S.clone().addScaledVector(dir, a).addScaledVector(perp, bend)
    const wrist = S.clone().addScaledVector(dir, d)
    // upper arm: turn its rest direction (towards the elbow) onto the wanted one
    const pq = up.parent.getWorldQuaternion(new THREE.Quaternion())
    const rest1 = lo.position.clone().normalize().applyQuaternion(pq)
    const w1 = new THREE.Quaternion().setFromUnitVectors(rest1, elbow.clone().sub(S).normalize()).multiply(pq)
    up.quaternion.slerp(pq.clone().invert().multiply(w1), w)
    up.updateWorldMatrix(false, true)
    // forearm: from where the elbow now is, onto the wrist
    const uq = up.getWorldQuaternion(new THREE.Quaternion())
    const e = lo.getWorldPosition(new THREE.Vector3())
    const rest2 = hand.position.clone().normalize().applyQuaternion(uq)
    const w2 = new THREE.Quaternion().setFromUnitVectors(rest2, wrist.clone().sub(e).normalize()).multiply(uq)
    lo.quaternion.slerp(uq.clone().invert().multiply(w2), w)
    lo.updateWorldMatrix(false, true)
  }

  private bedOn = false
  /** Turn the bed on (lying) or off for every spring bone joint. */
  /** show or hide the shoes: the parts whose material is named like a shoe (e.g. "Shoes_01_CLOTH") */
  private showShoes(on: boolean) {
    if (!this.vrm || on === this.shoesShown) return
    this.shoesShown = on
    this.vrm.scene.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      if (mats.some(m => /shoe/i.test(m.name))) o.visible = on
    })
  }

  private surfaces: { collider: VRMSpringBoneCollider; shape: VRMSpringBoneColliderShapeSphere }[] = []
  private floorShape?: VRMSpringBoneColliderShapePlane
  private probeT = 0

  /**
   * Hair and cloth are spring bones that know nothing about the furniture. Ten times a second, cast short rays
   * from the head and the hips to the back, front, left and right, and down to the floor; where one hits
   * something solid (a backrest, a table, a wall), put a plane collider on that surface so the strands rest
   * against it instead of passing through. Directions with nothing near park their plane far below.
   */
  private probeSurroundings(dt: number, agent: Agent, physics?: Physics) {
    // the floor is at y = 0 in the world; the root rises during a jump
    this.floorShape?.offset.set(0, -this.root.position.y, 0)
    if (!physics || !this.vrm || !this.surfaces.length) return
    this.probeT -= dt
    if (this.probeT > 0) return
    this.probeT = 0.1
    const head = this.bone('head'), hips = this.bone('hips')
    if (!head || !hips) return
    this.root.updateMatrixWorld(true)
    const origins = [head.getWorldPosition(new THREE.Vector3()), hips.getWorldPosition(new THREE.Vector3())]
    const yaw = this.root.rotation.y, c = Math.cos(yaw), s = Math.sin(yaw)
    SURFACE_DIRS.forEach((d, i) => {
      // the direction in the world: the avatar's local x (left) and z (forward) turned by its yaw
      const dir = { x: d[0] * c + d[2] * s, y: d[1], z: -d[0] * s + d[2] * c }
      let best: ReturnType<Physics['hit']> = null
      for (const o of origins) {
        const h = physics.hit({ x: o.x, y: o.y, z: o.z }, dir, d[1] < 0 ? 2.5 : SURFACE_REACH, agent.name)
        if (h && (!best || h.distance < best.distance)) best = h
      }
      const { shape } = this.surfaces[i]
      if (!best) { shape.offset.set(0, PARKED, 0); shape.radius = 0.01; return }
      // a big sphere whose surface touches the hit point, from behind it: like a flat patch of that surface
      const n = best.normal
      const centre = new THREE.Vector3(best.point.x - n.x * SURFACE_SPHERE, best.point.y - n.y * SURFACE_SPHERE, best.point.z - n.z * SURFACE_SPHERE)
      shape.offset.copy(this.root.worldToLocal(centre))
      shape.radius = SURFACE_SPHERE
    })
  }

  private setBedCollision(on: boolean) {
    const joints = this.vrm?.springBoneManager?.joints
    const group = this.bedGroup
    if (!joints || !group) return
    if (on) this.bedCollider?.updateWorldMatrix(true, false) // keep the collider's matrix current for the physics
    if (on === this.bedOn) return
    this.bedOn = on
    for (const j of joints) {
      const i = j.colliderGroups.indexOf(group)
      if (on && i < 0) j.colliderGroups.push(group)
      else if (!on && i >= 0) j.colliderGroups.splice(i, 1)
    }
  }

  /** the hair's spring joints (those under the head) and their own settings, to give back after lying down */
  private hair: { joint: VRMSpringBoneJoint; stiffness: number; gravityPower: number; dragForce: number; gravityDir: THREE.Vector3 }[] = []
  private hairDown = false

  /**
   * Lying down, long hair keeps the shape it has standing (down the back, toward the feet), so the body pushes it up
   * and it floats over the chest. While lying, make it soft and heavy and let it fall toward the head end of the bed:
   * it spreads over the pillow. Getting up gives the model's own settings back.
   */
  private layHair(on: boolean) {
    if (on !== this.hairDown) {
      this.hairDown = on
      for (const h of this.hair) {
        const st = h.joint.settings
        st.stiffness = on ? HAIR_LYING.stiffness : h.stiffness
        st.gravityPower = on ? HAIR_LYING.gravity : h.gravityPower
        st.dragForce = on ? HAIR_LYING.drag : h.dragForce
        if (!on) st.gravityDir.copy(h.gravityDir)
      }
    }
    if (!on || !this.hair.length) return
    // the hair rests on the pillow, which is higher than the mattress: lift the bed's slab to the top under the head
    const top = this.bedTop + HAIR_LYING.above - BED_RADIUS
    this.bedShape?.offset.setY(top)
    this.bedShape?.tail.setY(top)
    const head = this.bone('head'), hips = this.bone('hips')
    if (!head || !hips) return
    const d = head.getWorldPosition(new THREE.Vector3()).sub(hips.getWorldPosition(new THREE.Vector3())).setY(0)
    if (d.lengthSq() < 1e-6) return
    const dir = d.normalize().multiplyScalar(HAIR_LYING.toHead).setY(-1).normalize()
    for (const h of this.hair) h.joint.settings.gravityDir.copy(dir)
  }
}

/** hair lying in bed: soft, heavy, slow, and pulled this much toward the head end for each unit down */
const HAIR_LYING = { stiffness: 0.12, gravity: 1.0, drag: 0.6, toHead: 1.2, above: 0.015 }

/**
 * Seed-san (the sample avatar for Luna) has a third, robot arm on its backpack, with a cable and a plug. It is not a
 * humanoid bone, so no pose moves it: it stays stiff, sticks out and dips through beds. Avatars here have just two
 * arms, so everything that hangs on the `robo_*` bones is removed: a vertex counts when a robo bone pulls it most,
 * and every triangle with such a vertex is dropped (the cable is part of the clothes mesh, so a whole part cannot
 * simply be hidden). A part with nothing left is hidden. Models without robo bones are left alone.
 */
function hideRoboParts(root: THREE.Object3D) {
  root.traverse(o => {
    const m = o as THREE.SkinnedMesh
    if (!m.isSkinnedMesh) return
    const robo = m.skeleton.bones.map(b => b.name.startsWith('robo_'))
    if (!robo.some(Boolean)) return
    const geo = m.geometry
    const joint = geo.getAttribute('skinIndex'), weight = geo.getAttribute('skinWeight')
    const gone = new Uint8Array(joint.count)
    let n = 0
    for (let v = 0; v < joint.count; v++) {
      let best = 0, bw = -1
      for (let k = 0; k < 4; k++) {
        const w = weight.getComponent(v, k)
        if (w > bw) { bw = w; best = joint.getComponent(v, k) }
      }
      if (robo[best]) { gone[v] = 1; n++ }
    }
    if (!n) return
    const index = geo.index
    if (!index) { if (n === joint.count) m.visible = false; return }
    const keep: number[] = []
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2)
      if (!gone[a] && !gone[b] && !gone[c]) keep.push(a, b, c)
    }
    if (!keep.length) m.visible = false
    else geo.setIndex(keep)
  })
}

/** top of the beds and cots (the mattress is 0.5 m, see tools/blender/build_room.py), and the curve radius of the slab */
const BED_TOP = 0.5
/** directions probed for nearby surfaces, in the avatar's frame (x left, z forward): back, front, left, right, down */
const SURFACE_DIRS: [number, number, number][] = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, -1, 0]]
/** how far from the head or hips a surface still matters for hair and clothes, metres */
const SURFACE_REACH = 0.45
/** a collider this far below the avatar pushes nothing */
const PARKED = -100
/** radius of the spheres that stand in for nearby surfaces (backrests, tables, walls), metres */
const SURFACE_SPHERE = 0.35
/** least spring gravity and drag for hair and cloth, so they hang and settle (see load) */
const MIN_GRAVITY = 0.2
/** from the wrist to the middle of the palm, metres */
const HAND_LEN = 0.06
/**
 * taking the shoes off, seated: the knee comes up and out and the leg turns so the foot is in front, within reach
 * of both hands (6-7 cm from the palms on a small VRoid avatar), the knee staying 0.2 m from the chest
 */
const SHOE_LIFT = { thigh: 0.8, out: 0.7, twist: 0.6, knee: 0.2, spine: 0.8, chest: 0.35 }
const MIN_DRAG = 0.4

type V3 = [number, number, number]
type PoseFn = (n: BoneName, x?: number, y?: number, z?: number, rate?: number) => void
type FacePreset = 'happy' | 'sad' | 'angry' | 'surprised' | 'relaxed'
const FACE_PRESETS: FacePreset[] = ['happy', 'sad', 'angry', 'surprised', 'relaxed']
/** VRM expression weights for each emotion (acting.ts) */
const EMOTION_FACE: Record<Emotion, Partial<Record<FacePreset, number>>> = {
  neutral: { happy: 0.05 },
  happy: { happy: 0.85 },
  sad: { sad: 0.8 },
  angry: { angry: 0.75 },
  surprised: { surprised: 0.85 },
  relaxed: { relaxed: 0.7 },
  shy: { happy: 0.45, relaxed: 0.3 },
}
/** a light smile while talking, and a calm face while asleep */
const TALK_FACE: Partial<Record<FacePreset, number>> = { happy: 0.35 }
const SLEEP_FACE: Partial<Record<FacePreset, number>> = { happy: 0.15 }
const BED_RADIUS = 1.5

/**
 * Arm angles (radians) for typing, sitting idle and talking while seated. Tuned against public/models/room.glb
 * with two sample VRMs: the typing hands stay above the keyboard, seated hands rest beside the thighs, and the
 * talking hand rises to chest height, so arms stay clear of seats, the desk and the dining table.
 */
const TYPE_ARM = { upX: -1.25, upZ: 0.8, lowY: 1.15, handX: 0 }
const SIT_ARM = { upX: -0.3, upZ: 1.3, lowY: 0.9, handX: 0.15 }
const SIT_TALK = { upX: -0.6, upZ: -0.2, lowY: 1.8 }

type BoneName = Parameters<VRM['humanoid']['getNormalizedBoneNode']>[0]
/** bones that the motion clips turn and the procedural pose does not set */
const CLIP_ONLY: BoneName[] = ['upperChest', 'leftShoulder', 'rightShoulder', 'leftToes', 'rightToes']
/** someone further round than this from straight ahead (radians, about 110°) is behind: the head does not turn */
const LOOK_BEHIND = 1.9

/**
 * How thick the thighs are: the distance from the thigh's bone line to its skin, for the vertices that mostly
 * follow the upper leg, around the middle of the thigh (99th percentile, so a stray vertex does not count).
 */
function thighRadius(vrm: VRM) {
  const h = vrm.humanoid
  const top = h.getRawBoneNode('leftUpperLeg'), knee = h.getRawBoneNode('leftLowerLeg')
  if (!top || !knee) return 0.07
  vrm.scene.updateMatrixWorld(true)
  const a = top.getWorldPosition(new THREE.Vector3()), b = knee.getWorldPosition(new THREE.Vector3())
  const axis = b.clone().sub(a), len = axis.length()
  axis.normalize()
  const d: number[] = [], v = new THREE.Vector3()
  vrm.scene.traverse(o => {
    if (!(o instanceof THREE.SkinnedMesh)) return
    const pos = o.geometry.getAttribute('position'), si = o.geometry.getAttribute('skinIndex'), sw = o.geometry.getAttribute('skinWeight')
    if (!si || !sw) return
    const bi = o.skeleton.bones.indexOf(top as THREE.Bone)
    if (bi < 0) return
    for (let i = 0; i < pos.count; i += 2) {
      let best = 0, idx = -1
      for (let k = 0; k < 4; k++) { const wk = sw.getComponent(i, k); if (wk > best) { best = wk; idx = si.getComponent(i, k) } }
      if (idx !== bi || best < 0.6) continue
      o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld)
      const rel = v.clone().sub(a), along = rel.dot(axis)
      if (along < len * 0.25 || along > len * 0.75) continue
      d.push(rel.addScaledVector(axis, -along).length())
    }
  })
  if (!d.length) return 0.07
  d.sort((x, y) => x - y)
  return Math.min(0.12, d[Math.floor(d.length * 0.99)])
}

/**
 * How deep the body is behind the model's origin: the torso's back and the back of the head (whichever is deeper),
 * from the vertices that follow them (99th percentile, hair left out).
 */
function backDepth(vrm: VRM) {
  const h = vrm.humanoid
  vrm.scene.updateMatrixWorld(true)
  // lying, the body turns about its feet, so the depth behind the model's origin (it faces +z) is what goes down
  const parts = [['hips', 'spine', 'chest', 'upperChest'], ['head', 'neck']]
  let deepest = 0.1
  const v = new THREE.Vector3()
  for (const names of parts) {
    const bones = new Set(names.map(n => h.getRawBoneNode(n as Parameters<typeof h.getRawBoneNode>[0])).filter(Boolean))
    const d: number[] = []
    vrm.scene.traverse(o => {
      if (!(o instanceof THREE.SkinnedMesh) || /hair/i.test(o.name)) return
      const pos = o.geometry.getAttribute('position'), si = o.geometry.getAttribute('skinIndex'), sw = o.geometry.getAttribute('skinWeight')
      if (!si || !sw) return
      for (let i = 0; i < pos.count; i += 2) {
        let best = 0, idx = -1
        for (let k = 0; k < 4; k++) { const wk = sw.getComponent(i, k); if (wk > best) { best = wk; idx = si.getComponent(i, k) } }
        if (best < 0.5 || !bones.has(o.skeleton.bones[idx])) continue
        o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld)
        d.push(-v.z)
      }
    })
    if (!d.length) continue
    d.sort((x, y) => x - y)
    deepest = Math.max(deepest, d[Math.floor(d.length * 0.99)])
  }
  return Math.min(0.25, deepest)
}
