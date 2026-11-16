import { describe, expect, it } from 'vitest'
import { MemoryStream } from '../src/memory'

describe('MemoryStream', () => {
  it('retrieves relevant and important memories first', () => {
    const m = new MemoryStream()
    m.add(0, 'finished sleep in bed', 2)
    m.add(0, 'Luna talked about her favourite book', 6)
    m.add(0, 'finished use_computer at desk', 2)
    expect(m.retrieve(10, 'Luna wants to talk about a book', 1)[0].text).toContain('Luna')
  })
  it('prefers recent memories when otherwise equal', () => {
    const m = new MemoryStream()
    m.add(0, 'old thing happened', 3)
    m.add(60 * 500, 'new thing happened', 3)
    expect(m.retrieve(60 * 500, 'unrelated', 1)[0].text).toContain('new')
  })
  it('prunes low-importance events but keeps reflections', () => {
    const m = new MemoryStream(3)
    m.add(0, 'insight', 5, 'reflection')
    m.add(1, 'boring', 1)
    m.add(2, 'important', 9)
    m.add(3, 'later', 4)
    expect(m.items.map(i => i.text)).toEqual(['insight', 'important', 'later'])
  })
  it('only counts events towards reflection', () => {
    const m = new MemoryStream()
    m.add(0, 'a', 4)
    m.add(0, 'b', 9, 'reflection')
    expect(m.unreflected).toBe(4)
  })
  it('round-trips through JSON', () => {
    const m = new MemoryStream()
    m.add(0, 'hello world', 3)
    const r = MemoryStream.fromJSON(JSON.parse(JSON.stringify(m.toJSON())))
    expect(r.items).toHaveLength(1)
    expect(r.add(1, 'next', 1).id).toBe(2)
  })
  it('tolerates garbage saved data', () => {
    expect(MemoryStream.fromJSON(null).items).toEqual([])
  })
})
