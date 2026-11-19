import { describe, expect, it } from 'vitest'
import { Agent } from '../src/agent'
import { AiriBrain } from '../src/airi'
import { World } from '../src/world'
import type { Action, Brain, Observation, Persona } from '../src/types'

const persona: Persona = { name: 'Airi', description: 'test', color: 0, sleepWindow: [1, 9], bed: 'bed' }

/** the character's own brain: always wants to read, and counts how often it was asked */
class OwnBrain implements Brain {
  asked = 0
  async decide(): Promise<Action> { this.asked++; return { type: 'interact', object: 'bookshelf', verb: 'read' } }
}

const tick = () => new Promise(r => setTimeout(r, 0))
const obs = {} as Observation

describe('AiriBrain', () => {
  it('asks the character\'s own brain while AIRI is not connected', async () => {
    const own = new OwnBrain(), b = new AiriBrain(own)
    expect(await b.decide(persona, obs)).toEqual({ type: 'interact', object: 'bookshelf', verb: 'read' })
    expect(own.asked).toBe(1)
  })

  it('while AIRI is connected, waits for her action and never asks the own brain', async () => {
    const own = new OwnBrain(), b = new AiriBrain(own)
    const turns: Observation[] = []
    b.onTurn = o => turns.push(o)
    b.setControl(true)
    let got: Action | undefined
    b.decide(persona, obs).then(a => { got = a })
    await tick()
    expect(got).toBeUndefined()
    expect(b.awaiting).toBe(true)
    expect(turns).toHaveLength(1)
    expect(b.act({ type: 'say', text: 'hello' })).toBe('now')
    await tick()
    expect(got).toEqual({ type: 'say', text: 'hello' })
    expect(own.asked).toBe(0)
  })

  it('keeps an action sent while the character is busy for its next decision', async () => {
    const b = new AiriBrain(new OwnBrain())
    b.setControl(true)
    expect(b.act({ type: 'wait', minutes: 5 })).toBe('queued')
    expect(await b.decide(persona, obs)).toEqual({ type: 'wait', minutes: 5 })
  })

  it('hands a waiting decision back to the own brain when AIRI leaves', async () => {
    const own = new OwnBrain(), b = new AiriBrain(own)
    b.setControl(true)
    const pending = b.decide(persona, obs)
    b.setControl(false)
    expect(await pending).toEqual({ type: 'interact', object: 'bookshelf', verb: 'read' })
    expect(own.asked).toBe(1)
  })
})

describe('AIRI in the world', () => {
  const run = async (a: Agent, done: () => boolean, max = 4000) => {
    for (let i = 0; i < max && !done(); i++) { a.tick(0.05, 0.2); await tick() }
  }

  it('stands by for AIRI, does what she says, and gets up early when she interrupts', async () => {
    const w = new World()
    w.minutes = 12 * 60
    const own = new OwnBrain(), b = new AiriBrain(own)
    b.setControl(true)
    const a = new Agent(persona, { x: 0, z: 0.2 }, b, w)
    await run(a, () => b.awaiting)
    expect(a.state.k).toBe('thinking')
    // nothing happens on its own while AIRI decides
    for (let i = 0; i < 50; i++) { a.tick(0.05, 0.2); await tick() }
    expect(a.state.k).toBe('thinking')

    b.act({ type: 'interact', object: 'sofa_seat_1', verb: 'relax' })
    await run(a, () => a.state.k === 'doing')
    expect(a.state.k).toBe('doing')
    expect(a.pose).toBe('sit')
    expect(a.look().place).toBe('house')

    // a new action while seated waits for the activity, unless she cuts it short
    expect(b.act({ type: 'say', text: 'I am getting up.' })).toBe('queued')
    expect(a.stopActivity()).toBe(true)
    await run(a, () => a.memory.some(m => m.includes('said')) || a.state.k === 'thinking' && b.awaiting)
    expect(a.pose).toBe('stand')
    expect(own.asked).toBe(0)
  })

  it('stops a plain walk where it is, but lets a skill\'s moves finish', async () => {
    const w = new World()
    w.minutes = 12 * 60
    const b = new AiriBrain(new OwnBrain())
    b.setControl(true)
    const a = new Agent(persona, { x: 0, z: 0.2 }, b, w)
    await run(a, () => b.awaiting)
    b.act({ type: 'interact', object: 'fridge', verb: 'grab_snack' })
    await run(a, () => a.state.k === 'moving')
    for (let i = 0; i < 10; i++) { a.tick(0.05, 0.2); await tick() }
    expect(a.state.k).toBe('moving')
    expect(a.stopActivity()).toBe(true)
    expect(a.state.k).toBe('idle')
    expect(w.occupant('fridge')).toBeUndefined()

    // getting into bed: the squeeze along the bed is part of the skill, and is not cut short
    b.act({ type: 'interact', object: 'bed', verb: 'sleep' })
    await run(a, () => a.state.k === 'moving' && !!(a.state as { exact?: boolean }).exact)
    expect(a.stopActivity()).toBe(false)
  })
})
