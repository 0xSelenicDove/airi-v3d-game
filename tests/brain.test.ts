import { describe, expect, it } from 'vitest'
import { coerceAction, parseAction } from '../src/brain'
import type { Observation } from '../src/types'

const obs = {
  yourBed: 'bed2',
  objects: [
    { id: 'bed', kind: 'bed', verbs: ['sleep'] },
    { id: 'bed2', kind: 'bed', verbs: ['sleep'] },
    { id: 'desk', kind: 'computer desk', verbs: ['use_computer'] },
    { id: 'bookshelf', kind: 'bookshelf', verbs: ['read'] },
  ],
} as unknown as Observation

describe('parseAction', () => {
  it('parses a strict interact action', () => {
    expect(parseAction('{"type":"interact","object":"desk","verb":"use_computer","thought":"fun"}'))
      .toMatchObject({ type: 'interact', object: 'desk', verb: 'use_computer', thought: 'fun' })
  })
  it('extracts JSON from prose and code fences', () => {
    expect(parseAction('Sure!\n```json\n{"type":"say","text":"hi {there}"}\n```')).toMatchObject({ type: 'say', text: 'hi {there}' })
  })
  it('defaults wait minutes', () => {
    expect(parseAction('{"type":"wait"}')).toEqual({ type: 'wait', minutes: 10 })
  })
  it('rejects bad input', () => {
    expect(() => parseAction('no json')).toThrow()
    expect(() => parseAction('{"type":"dance"}')).toThrow()
    expect(() => parseAction('{"type":"say"')).toThrow()
  })
})

describe('coerceAction', () => {
  it('recovers object + verb from a near-miss', () => {
    expect(coerceAction('{"command":"sleep bed2"}', obs)).toEqual({ type: 'interact', object: 'bed2', verb: 'sleep' })
  })
  it('redirects "sleep in a bed" to your own bed', () => {
    expect(coerceAction('{"action":"sleep in bed"}', obs)).toMatchObject({ object: 'bed2', verb: 'sleep' })
  })
  it('uses a lone verb', () => {
    expect(coerceAction('{"plan":"read"}', obs)).toMatchObject({ object: 'bookshelf', verb: 'read' })
  })
  it('matches whole words only', () => {
    expect(coerceAction('{"thought":"I have already eaten"}', obs)).toBeNull()
  })
  it('skips objects that are in use', () => {
    const busy = { ...obs, objects: obs.objects.map(o => (o.id === 'desk' ? { ...o, inUseBy: 'Luna' } : o)) } as Observation
    expect(coerceAction('{"target":"desk"}', busy)).toBeNull()
  })
  it('falls back to plain speech and keeps the thought', () => {
    expect(coerceAction('{"text":"Good morning!","thought":"be nice"}', obs)).toEqual({ type: 'say', text: 'Good morning!', thought: 'be nice' })
  })
})
