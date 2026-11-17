import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  VRM, VRMLoaderPlugin, VRMUtils, VRMSpringBoneCollider, VRMSpringBoneColliderShapeCapsule, VRMSpringBoneColliderShapePlane,
  type VRMSpringBoneColliderGroup,
} from '@pixiv/three-vrm'
import { JUMP_AIR, JUMP_CROUCH, WALK_SPEED, type Agent } from './agent'
import type { Emotion, Gesture } from './acting'
import type { Physics } from './physics'

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
  /** VRM 0.x rigs face -Z, so bone-local X and Z rotations are mirrored compared with VRM 1.0 */
  private v0 = false
  private hipsY = 0.9
  private walkP = 0
  /** how far the current gesture has blended in, 0..1, and which one it is (kept while it fades out) */
  private gestureW = 0
  private gestureNow: Gesture | '' = ''
  /** how far the hips are lowered because the knees bend (crouching for a jump), metres */
  private crouchDrop = 0
  /** current weight of each VRM expression preset that shows an emotion */
  private face: Record<FacePreset, number> = { happy: 0.05, sad: 0, angry: 0, surprised: 0, relaxed: 0 }
  private t = 0
  private yaw = 0
  private lookYaw = 0
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

  constructor(color: number) {
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
    this.v0 = vrm.meta?.metaVersion === '0'
    this.capsule.visible = false
    this.inner.add(vrm.scene)

    // a big capsule lying along the bed (the avatar's local z while lying), its top at BED_TOP: a wide, shallow
    // curve, so what hangs over the side slides down beside the frame, and nothing is held up in mid air
    const slab = new VRMSpringBoneCollider(new VRMSpringBoneColliderShapeCapsule({
      radius: BED_RADIUS,
      offset: new THREE.Vector3(0, BED_TOP - BED_RADIUS, -1.1),
      tail: new THREE.Vector3(0, BED_TOP - BED_RADIUS, 1.1),
    }))
    this.root.add(slab)
    this.bedCollider = slab
    this.bedGroup = { colliders: [slab], name: 'bed' }
    this.bedOn = false
    // furniture and walls near the hair and clothes: planes placed each moment where rays from the head and the
    // hips hit something solid (see probeSurroundings). They start parked far below, where they push nothing.
    this.surfaces = SURFACE_DIRS.map(() => {
      const shape = new VRMSpringBoneColliderShapePlane({ offset: new THREE.Vector3(0, PARKED, 0), normal: new THREE.Vector3(0, 1, 0) })
      const collider = new VRMSpringBoneCollider(shape)
      this.root.add(collider)
      return { collider, shape }
    })
    const surfaceGroup: VRMSpringBoneColliderGroup = { colliders: this.surfaces.map(x => x.collider), name: 'surroundings' }
    for (const j of vrm.springBoneManager?.joints ?? []) j.colliderGroups.push(surfaceGroup)

    const hips = vrm.humanoid.getNormalizedBoneNode('hips')
    if (hips) {
      vrm.scene.updateMatrixWorld(true)
      this.hipsY = hips.getWorldPosition(new THREE.Vector3()).y
    }
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
    const moving = (st.k === 'moving' || st.k === 'chatting') && agent.speedNow > 0.05
    const verb = st.k === 'doing' ? st.aff.verb : ''
    const sit = agent.pose === 'sit', lie = agent.pose === 'lie', swim = agent.pose === 'swim'
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
    // about 0.9 strides per second at walking speed, slower when the agent slows down
    if (moving) this.walkP += dt * 5.8 * Math.min(1.2, agent.speedNow / WALK_SPEED)
    const p = this.walkP, s = Math.sin(p), c = Math.cos(p)
    const breath = Math.sin(t * 1.7)
    const P = (n: BoneName, x = 0, y = 0, z = 0, rate = k) => this.pose(n, rate, x, y, z)

    // ---- legs ----
    const sw = t * 3.4 // swimming stroke phase
    if (swim) {
      P('leftUpperLeg', Math.sin(sw * 2.4) * 0.35, 0, -0.03); P('rightUpperLeg', -Math.sin(sw * 2.4) * 0.35, 0, 0.03)
      P('leftLowerLeg', Math.max(0, -Math.sin(sw * 2.4)) * 0.5); P('rightLowerLeg', Math.max(0, Math.sin(sw * 2.4)) * 0.5)
      P('leftFoot', 0.3); P('rightFoot', 0.3)
    } else if (sit) {
      P('leftUpperLeg', -Math.PI / 2, 0.1, -0.05); P('rightUpperLeg', -Math.PI / 2, -0.1, 0.05)
      P('leftLowerLeg', Math.PI / 2 - 0.1); P('rightLowerLeg', Math.PI / 2 - 0.1)
      P('leftFoot', 0.1); P('rightFoot', 0.1)
    } else if (moving) {
      P('leftUpperLeg', s * 0.6); P('rightUpperLeg', -s * 0.6)
      P('leftLowerLeg', Math.max(0, -c) * 0.95); P('rightLowerLeg', Math.max(0, c) * 0.95)
      P('leftFoot', -s * 0.25); P('rightFoot', s * 0.25)
    } else {
      P('leftUpperLeg', 0, 0, -0.03); P('rightUpperLeg', 0, 0, 0.03)
      P('leftLowerLeg'); P('rightLowerLeg'); P('leftFoot'); P('rightFoot')
    }

    // ---- torso, arms, by activity ----
    let headX = 0, headY = 0
    if (moving) {
      P('hips', 0, -s * 0.1, c * 0.04)
      P('spine', 0.06, s * 0.1); P('chest', 0, s * 0.08); P('neck')
      P('leftUpperArm', -s * 0.5, 0, -1.3); P('rightUpperArm', s * 0.5, 0, 1.3)
      P('leftLowerArm', 0, -0.45 - Math.max(0, -s) * 0.3); P('rightLowerArm', 0, 0.45 + Math.max(0, s) * 0.3)
      P('leftHand'); P('rightHand')
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
      P('hips'); P('spine', 0.02 * breath); P('chest', 0.03 * breath); P('neck')
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
      // standing idle: breathing + slow weight shift
      P('hips', 0, 0, Math.sin(t * 0.5) * 0.015)
      P('spine', 0.015 * breath); P('chest', 0.02 * breath); P('neck')
      P('leftUpperArm', 0.02 * breath, 0, -1.3 + 0.015 * breath); P('rightUpperArm', 0.02 * breath, 0, 1.3 - 0.015 * breath)
      P('leftLowerArm', 0, -0.2); P('rightLowerArm', 0, 0.2)
      P('leftHand'); P('rightHand')
      headY = Math.sin(t * 0.4) * 0.05
      if (speaking) {
        // talk with the right hand
        P('rightUpperArm', -0.7 + Math.sin(t * 4.5) * 0.15, 0, 1.0)
        P('rightLowerArm', 0, 1.2 + Math.sin(t * 6.3) * 0.3)
        P('rightHand', 0, 0, Math.sin(t * 6.3 + 1) * 0.2)
      }
    }
    // ---- gestures (acting.ts): blended on their own weight, so they fully replace the pose above while they
    // play and fade back out at the end, instead of settling halfway between two targets ----
    const playing = agent.gesture && now < agent.gestureUntil && !lie && !swim ? agent.gesture : ''
    if (playing) this.gestureNow = playing
    this.gestureW += ((playing ? 1 : 0) - this.gestureW) * (1 - Math.exp(-dt * 9))
    const gw = this.gestureW > 0.01 ? this.gestureW : 0
    const gElapsed = (now - agent.gestureStart) / 1000
    const gu = Math.min(1, Math.max(0, (now - agent.gestureStart) / Math.max(1, agent.gestureUntil - agent.gestureStart)))
    let crouch = 0
    if (gw && this.gestureNow) crouch = this.bodyGesture(this.gestureNow, gu, gElapsed, t, gw, P, sit)
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
        want = Math.max(-1.0, Math.min(1.0, a))
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
    const tgtY = lie ? 0.62 : swim ? -0.08 + Math.sin(t * 2) * 0.02 : sit ? -(this.hipsY - 0.55) : 0
    // lying pivots about the feet, so slide the body along its length to centre the hips on the bed
    const tgtZ = lie ? this.hipsY * 0.95 : swim ? -this.hipsY * 0.95 : sit ? -0.12 : 0
    const kp = 1 - Math.exp(-dt * 7)
    this.cur.pitch += (tgtPitch - this.cur.pitch) * kp
    this.cur.y += (tgtY - this.cur.y) * kp
    this.cur.z += (tgtZ - this.cur.z) * kp
    this.inner.rotation.x = this.cur.pitch
    // bent knees lower the hips by the height the legs lose, so the feet stay on the ground (see bodyGesture)
    this.crouchDrop += (this.legDrop(crouch) - this.crouchDrop) * (1 - Math.exp(-dt * 20))
    this.inner.position.set(0, this.cur.y - this.crouchDrop, this.cur.z)
    const hips = this.bone('hips')
    if (hips) hips.position.y = this.hipsY + (moving ? Math.abs(c) * 0.03 : Math.sin(t * 1.7) * 0.003)

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
    this.setBedCollision(lie)
    this.probeSurroundings(dt, agent, physics)
    this.vrm.update(dt)
  }

  /**
   * Arms, legs and torso of a gesture (`u` = 0..1 through it, `sec` = seconds since it started). Returns how far
   * the knees bend (0..1) so the hips can be lowered to keep the feet on the ground.
   */
  private bodyGesture(g: Gesture, u: number, sec: number, t: number, w: number, P: PoseFn, sit: boolean): number {
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
  private headGesture(g: Gesture, u: number, w: number, P: PoseFn) {
    switch (g) {
      case 'nod': P('head', 0.28 * Math.max(0, Math.sin(u * Math.PI * 4)), 0, 0, w); break
      case 'shake_head': P('head', 0, 0.45 * Math.sin(u * Math.PI * 4) * Math.sin(u * Math.PI), 0, w); break
      case 'bow': P('head', 0.2 * Math.sin(Math.min(1, u * 1.6) * Math.PI), 0, 0, w); break
      case 'stretch': P('head', -0.25, 0, 0, w); break
      case 'think': P('head', 0.12, 0, 0.14, w); break
      case 'shrug': P('head', 0, 0, 0.12, w); break
      case 'cheer': P('head', -0.15, 0, 0, w); break
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

  private bedOn = false
  /** Turn the bed on (lying) or off for every spring bone joint. */
  private surfaces: { collider: VRMSpringBoneCollider; shape: VRMSpringBoneColliderShapePlane }[] = []
  private probeT = 0

  /**
   * Hair and cloth are spring bones that know nothing about the furniture. Ten times a second, cast short rays
   * from the head and the hips to the back, front, left and right, and down to the floor; where one hits
   * something solid (a backrest, a table, a wall), put a plane collider on that surface so the strands rest
   * against it instead of passing through. Directions with nothing near park their plane far below.
   */
  private probeSurroundings(dt: number, agent: Agent, physics?: Physics) {
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
      if (!best) { shape.offset.set(0, PARKED, 0); shape.normal.set(0, 1, 0); return }
      shape.offset.copy(this.root.worldToLocal(new THREE.Vector3(best.point.x, best.point.y, best.point.z)))
      // normals are directions: turn them by the inverse yaw only
      const n = best.normal
      shape.normal.set(n.x * c - n.z * s, n.y, n.x * s + n.z * c).normalize()
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
}

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
/** a plane this far below the avatar pushes nothing */
const PARKED = -100

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
