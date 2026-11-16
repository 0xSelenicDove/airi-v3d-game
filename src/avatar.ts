import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  VRM, VRMLoaderPlugin, VRMUtils, VRMSpringBoneCollider, VRMSpringBoneColliderShapeCapsule,
  type VRMSpringBoneColliderGroup,
} from '@pixiv/three-vrm'
import type { Agent } from './agent'

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
  private t = 0
  private yaw = 0
  private lookYaw = 0
  private cur = { pitch: 0, y: 0, z: 0 }
  private happy = 0
  private nextFlip = 4
  private flip = 0
  private book = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.03, 0.32),
    new THREE.MeshStandardMaterial({ color: 0xe8d9a8 }),
  )
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

  private updateLabel(agent: Agent, sit: boolean, lie: boolean) {
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
    const y = lie ? (this.vrm ? 1.0 : 1.35) : sit ? this.headTop - (this.hipsY - 0.55) : this.headTop
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

  update(dt: number, agent: Agent) {
    this.t += dt
    const t = this.t
    const now = performance.now()
    const st = agent.state
    const moving = st.k === 'moving'
    const verb = st.k === 'doing' ? st.aff.verb : ''
    const sit = agent.pose === 'sit', lie = agent.pose === 'lie'
    const speaking = !!agent.speech && now < agent.speechUntil

    // smooth heading (shortest way round)
    let dy = agent.heading - this.yaw
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    this.yaw += dy * (1 - Math.exp(-dt * 10))
    this.root.position.set(agent.pos.x, 0, agent.pos.z)
    this.root.rotation.y = this.yaw
    this.updateLabel(agent, sit, lie)

    if (!this.vrm) {
      // lying: tip the capsule onto its side and rest it on the mattress (top at ~0.5 m, radius 0.3),
      // otherwise its centre would sit at floor level, inside the bed
      this.inner.rotation.x = lie ? Math.PI / 2 : 0
      this.inner.position.y = lie ? 0.82 : 0
      this.capsule.position.y = lie ? 0 : sit ? 0.55 : 0.75
      return
    }

    const k = 1 - Math.exp(-dt * 12)        // pose blend rate
    const kSlow = 1 - Math.exp(-dt * 6)
    if (moving) this.walkP += dt * 9
    const p = this.walkP, s = Math.sin(p), c = Math.cos(p)
    const breath = Math.sin(t * 1.7)
    const P = (n: BoneName, x = 0, y = 0, z = 0, rate = k) => this.pose(n, rate, x, y, z)

    // ---- legs ----
    if (sit) {
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
    if (!lie) {
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

    // ---- body placement (blended so sitting down / lying down is not a snap) ----
    const tgtPitch = lie ? -Math.PI / 2 : 0
    const tgtY = lie ? 0.62 : sit ? -(this.hipsY - 0.55) : 0
    // lying pivots about the feet, so slide the body along its length to centre the hips on the bed
    const tgtZ = lie ? this.hipsY * 0.95 : sit ? -0.12 : 0
    const kp = 1 - Math.exp(-dt * 7)
    this.cur.pitch += (tgtPitch - this.cur.pitch) * kp
    this.cur.y += (tgtY - this.cur.y) * kp
    this.cur.z += (tgtZ - this.cur.z) * kp
    this.inner.rotation.x = this.cur.pitch
    this.inner.position.set(0, this.cur.y, this.cur.z)
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
      this.happy += ((speaking ? 0.35 : 0.05) - this.happy) * kSlow
      em.setValue('happy', lie ? 0.15 : this.happy)
      em.setValue('aa', speaking ? Math.max(0, 0.25 + Math.sin(t * 14) * 0.25 + Math.sin(t * 9.3) * 0.15) : 0)
    }
    this.setBedCollision(lie)
    this.vrm.update(dt)
  }

  private bedOn = false
  /** Turn the bed on (lying) or off for every spring bone joint. */
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

/** top of the beds and cots (the mattress is 0.5 m, see tools/blender/build_room.py), and the curve radius of the slab */
const BED_TOP = 0.5
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
