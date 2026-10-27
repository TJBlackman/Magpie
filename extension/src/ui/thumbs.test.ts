import { describe, expect, it } from 'vitest';
import { ThumbCache } from './thumbs';

describe('ThumbCache', () => {
  it('learns from rows that carry a thumbnail and fills rows that do not', () => {
    const c = new ThumbCache();
    const full = c.fill([{ id: 'a', thumb: 'A' }, { id: 'b' }]);
    expect(full[0]!.thumb).toBe('A');
    const later = c.fill<{ id: string; bytes?: number; thumb?: string }>([{ id: 'a', bytes: 9 }, { id: 'b' }]);
    expect(later[0]).toEqual({ id: 'a', bytes: 9, thumb: 'A' });
    expect(later[1]!.thumb).toBeUndefined();
  });
  it('keeps row identity when nothing is added', () => {
    const c = new ThumbCache();
    const row = { id: 'a', thumb: 'A' };
    const bare = { id: 'b' };
    const [x, y] = c.fill([row, bare]);
    expect(x).toBe(row);
    expect(y).toBe(bare);
  });
  it('asks about a row without a thumbnail once', () => {
    const c = new ThumbCache();
    c.fill([{ id: 'a', thumb: 'A' }]);
    expect(c.missing([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toEqual(['b', 'c']);
    expect(c.missing([{ id: 'b' }, { id: 'c' }, { id: 'd' }])).toEqual(['d']);
  });
  it('fills from a thumbs answer', () => {
    const c = new ThumbCache();
    c.missing([{ id: 'b' }]);
    c.learn({ b: 'B', c: '' });
    expect(c.fill([{ id: 'b' }, { id: 'c' }])).toEqual([{ id: 'b', thumb: 'B' }, { id: 'c' }]);
  });
});
