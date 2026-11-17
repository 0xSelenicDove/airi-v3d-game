import { afterEach, describe, expect, it, vi } from 'vitest'
import { Physics } from '../src/physics'
import { Agent, JUMP_AIR, JUMP_CROUCH } from '../src/agent'
import { World } from '../src/world'
import { emotionOf, gestureOf, splitTags } from '../src/acting'
import { parseAction } from '../src/brain'
import type { Brain } from '../src/types'

const brain: Brain = { decide: async () => ({ type: 'wait', minutes: 600 }) }
const persona = { name: 'Airi', description: '', color: 0, sleepWindow: [0, 8] as [number, number], bed: 'bed' }

afterEach(() => vi.restoreAllMocks())

describe('physics world', () => {
  it('a dropped ball falls under gravity and comes to rest on the ground', async () => {
    const p = await Physics.create()
    const ball = p.addBall('b', { x: 50, y: 1.5, z: 50 })
    for (let i = 0; i < 240; i++) p.step(1 / 60)
    const t = ball.body.translation()
    expect(t.y).toBeGreaterThan(ball.radius - 0.01)
    expect(t.y).toBeLessThan(ball.radius + 0.02)
  })

  it('solid things block rays, empty space does not, and an agent does not block its own rays', async () => {
    const p = await Physics.create()
    p.addBox({ x: 51, y: 1, z: 50 }, { x: 0.2, y: 1, z: 0.5 })
    expect(p.isClear({ x: 50, y: 1, z: 50 }, { x: 1, y: 0, z: 0 }, 2)).toBe(false)
    expect(p.isClear({ x: 50, y: 1, z: 50 }, { x: -1, y: 0, z: 0 }, 2)).toBe(true)
    p.syncAgent('me', { x: 50, y: 0, z: 52 }, 'stand')
    p.step(1 / 60)
    expect(p.isClear({ x: 50, y: 1, z: 52 }, { x: 0, y: 1, z: 0 }, 1, 'me')).toBe(true)
    expect(p.isClear({ x: 50, y: 1, z: 51 }, { x: 0, y: 0, z: 1 }, 2)).toBe(false) // someone else's ray hits me
  })

  it('a person walking into a ball pushes it along', async () => {
    const p = await Physics.create()
    const ball = p.addBall('b', { x: 60, y: 0.17, z: 60 })
    for (let i = 0; i < 30; i++) p.step(1 / 60)
    let x = 58.5
    for (let i = 0; i < 120; i++) {           // walk 2.4 m east at 1.2 m/s
      x += 1.2 / 60
      p.syncAgent('walker', { x, y: 0, z: 60 }, 'stand')
      p.step(1 / 60)
    }
    expect(ball.body.translation().x).toBeGreaterThan(60.4)
  })
})

describe('acting', () => {
  it('reads emotion and gesture tags in Chinese and English', () => {
    expect(splitTags('（微笑）（挥挥右手）早上好！')).toEqual({ text: '早上好！', emotion: 'happy', gesture: 'wave_right' })
    expect(splitTags('(surprised) Oh!')).toMatchObject({ text: 'Oh!', emotion: 'surprised' })
    expect(splitTags('(note) not a tag')).toEqual({ text: '(note) not a tag' })
    expect(gestureOf('挥挥左手')).toBe('wave_left')
    expect(gestureOf('把右手举高')).toBe('raise_right_hand')
    expect(gestureOf('抬起右腿')).toBe('raise_right_leg')
    expect(emotionOf('害羞')).toBe('shy')
  })

  it('the LLM can ask for a gesture, or speak with a face and a gesture', () => {
    expect(parseAction('{"type":"gesture","gesture":"点头"}')).toMatchObject({ type: 'gesture', gesture: 'nod' })
    expect(parseAction('{"type":"say","text":"（开心）（欢呼）太好了！"}')).toMatchObject({ type: 'say', text: '太好了！', emotion: 'happy', gesture: 'cheer' })
  })

  it('a gesture needs room: a wall right beside the agent blocks a wave on that side only', async () => {
    const w = new World()
    w.space = await Physics.create()
    const p = w.space as Physics
    const a = new Agent(persona, { x: 70, z: 70 }, brain, w)
    a.heading = 0 // facing +z: its right hand is on the -x side
    p.addBox({ x: 69.55, y: 1.2, z: 70 }, { x: 0.05, y: 1.2, z: 1 })
    expect(a.whyNot('wave_right')).toMatch(/no room/)
    expect(a.whyNot('wave_left')).toBeNull()
    // a low shelf overhead blocks raising a hand and jumping
    p.addBox({ x: 70, y: 1.75, z: 70 }, { x: 1, y: 0.03, z: 1 })
    expect(a.whyNot('raise_left_hand')).toMatch(/no room/)
    expect(a.whyNot('jump')).toMatch(/no room/)
    a.pose = 'lie'
    expect(a.whyNot('nod')).toMatch(/lying/)
  })

  it('a jump rises and falls under gravity and lands', () => {
    const w = new World()
    const a = new Agent(persona, { x: 0, z: 0 }, brain, w)
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    a.state = { k: 'waiting', left: 1e9 }
    expect(a.play('jump')).toBeNull()
    const at = (s: number) => { now = 1000 + s * 1000; a.tick(0, 0); return a.lift }
    expect(at(JUMP_CROUCH * 0.5)).toBe(0)                       // still crouching
    const apex = at(JUMP_CROUCH + JUMP_AIR / 2)
    expect(apex).toBeCloseTo(9.81 * JUMP_AIR * JUMP_AIR / 8, 3) // v0^2 / 2g with v0 = g * T / 2
    expect(at(JUMP_CROUCH + JUMP_AIR * 0.25)).toBeLessThan(apex)
    expect(at(JUMP_CROUCH + JUMP_AIR + 0.1)).toBe(0)            // landed
  })
})
