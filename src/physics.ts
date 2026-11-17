import type RAPIER_NS from '@dimforge/rapier3d-compat'
import type { Space, Vec3 } from './types'

type Rapier = typeof RAPIER_NS
type Pose = 'stand' | 'sit' | 'lie' | 'swim'

/** a standing person as a capsule: 0.24 m radius, 1.58 m tall overall */
const AGENT_RADIUS = 0.24
const AGENT_HALF = 0.55
const AGENT_CENTRE = AGENT_HALF + AGENT_RADIUS

export interface Prop {
  id: string
  body: RAPIER_NS.RigidBody
  radius: number
  /** where it goes back to if it ever leaves the world */
  home: Vec3
}

export interface RayHit { point: Vec3; normal: Vec3; distance: number }

/**
 * The physical world (Rapier): solid furniture, walls, fences and trees as fixed triangle meshes, the ground,
 * each standing agent as a moving capsule, and loose props (balls) that fall, roll and get pushed around.
 * The agents still walk on the navigation grid; the capsules let them push props and block each other's gestures.
 */
export class Physics implements Space {
  readonly props: Prop[] = []
  private agents = new Map<string, { body: RAPIER_NS.RigidBody; collider: RAPIER_NS.Collider }>()
  /** colliders were added since the last step, so ray queries cannot see them yet */
  private stale = false

  private constructor(private R: Rapier, readonly world: RAPIER_NS.World) {}

  static async create(): Promise<Physics> {
    const mod = await import('@dimforge/rapier3d-compat')
    const R = (mod as unknown as { default?: Rapier }).default ?? (mod as unknown as Rapier)
    await R.init()
    const p = new Physics(R, new R.World({ x: 0, y: -9.81, z: 0 }))
    // the ground: a thick slab with its top at y = 0 (the floor, the yard and the meadow are all at 0)
    p.world.createCollider(R.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0).setFriction(0.8))
    return p
  }

  /** a fixed triangle mesh; `positions` are world-space xyz triples */
  addMesh(positions: Float32Array, indices: Uint32Array) {
    if (indices.length < 3) return
    this.world.createCollider(this.R.ColliderDesc.trimesh(positions, indices).setFriction(0.7))
    this.stale = true
  }

  addBox(centre: Vec3, half: Vec3) {
    this.world.createCollider(this.R.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(centre.x, centre.y, centre.z))
    this.stale = true
  }

  /** a light ball (like a beach ball) that bounces, rolls and is pushed by people walking into it */
  addBall(id: string, at: Vec3, radius = 0.17): Prop {
    const R = this.R
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setLinearDamping(0.35).setAngularDamping(0.5).setCcdEnabled(true),
    )
    this.world.createCollider(R.ColliderDesc.ball(radius).setDensity(60).setRestitution(0.55).setFriction(0.6), body)
    const prop = { id, body, radius, home: { ...at } }
    this.props.push(prop)
    return prop
  }

  /**
   * Move an agent's capsule to where it stands. Standing and walking agents are solid; seated, lying and
   * swimming ones are on furniture or in the water, so their capsule is switched off.
   */
  syncAgent(name: string, pos: Vec3, pose: Pose) {
    let a = this.agents.get(name)
    if (!a) {
      const body = this.world.createRigidBody(this.R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y + AGENT_CENTRE, pos.z))
      const collider = this.world.createCollider(this.R.ColliderDesc.capsule(AGENT_HALF, AGENT_RADIUS), body)
      a = { body, collider }
      this.agents.set(name, a)
    }
    a.collider.setEnabled(pose === 'stand')
    a.body.setNextKinematicTranslation({ x: pos.x, y: pos.y + AGENT_CENTRE, z: pos.z })
  }

  step(dt: number) {
    this.world.timestep = Math.min(1 / 30, Math.max(1 / 240, dt))
    this.world.step()
    this.stale = false
    for (const p of this.props) {
      const t = p.body.translation()
      if (t.y < -3 || Math.abs(t.x) > 150 || Math.abs(t.z) > 150) {
        p.body.setTranslation(p.home, true)
        p.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
      }
    }
  }

  private ray(from: Vec3, dir: Vec3, reach: number, ignore?: string): RayHit | null {
    if (this.stale) {
      // NOTICE:
      // Rapier adds new colliders to the structure that ray queries use only during World.step().
      // A step of a microsecond makes colliders added since the last frame visible without moving anything.
      // Source: node_modules/@dimforge/rapier3d-compat/dist/pipeline/world.d.ts (step, broadPhase).
      // Remove when Rapier offers a query-structure update without a step.
      const dt = this.world.timestep
      this.world.timestep = 1e-6
      this.world.step()
      this.world.timestep = dt
      this.stale = false
    }
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1
    const d = { x: dir.x / l, y: dir.y / l, z: dir.z / l }
    const own = ignore ? this.agents.get(ignore)?.body : undefined
    const hit = this.world.castRayAndGetNormal(new this.R.Ray(from, d), reach, true, undefined, undefined, undefined, own)
    if (!hit) return null
    const t = hit.timeOfImpact
    return { point: { x: from.x + d.x * t, y: from.y + d.y * t, z: from.z + d.z * t }, normal: { ...hit.normal }, distance: t }
  }

  isClear(from: Vec3, dir: Vec3, reach: number, ignore?: string) {
    return this.ray(from, dir, reach, ignore) === null
  }

  /** the first solid surface along a ray, if any, with its normal */
  hit(from: Vec3, dir: Vec3, reach: number, ignore?: string) {
    return this.ray(from, dir, reach, ignore)
  }
}
