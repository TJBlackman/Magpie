import { describe, expect, it } from 'vitest';
import { pickThumbs, withoutThumb } from './thumbs';

describe('withoutThumb', () => {
  it('drops the thumbnail and leaves the rest', () => {
    const row = { id: 'a', bytes: 5, thumb: 'data:image/jpeg;base64,xx' };
    const out = withoutThumb(row);
    expect(out).toEqual({ id: 'a', bytes: 5 });
    expect('thumb' in out).toBe(false);
    expect(row.thumb).toBe('data:image/jpeg;base64,xx');
  });
  it('returns the same object when there is nothing to drop', () => {
    const row: { id: string; bytes: number; thumb?: string } = { id: 'a', bytes: 5 };
    expect(withoutThumb(row)).toBe(row);
  });
});

describe('pickThumbs', () => {
  const rows = [
    { id: 'a', thumb: 'A' },
    { id: 'b' },
    { id: 'c', thumb: 'C' },
  ];
  it('answers only the ids asked for that have one', () => {
    expect(pickThumbs(rows, ['a', 'b', 'zzz'])).toEqual({ a: 'A' });
  });
  it('is empty for no ids', () => {
    expect(pickThumbs(rows, undefined)).toEqual({});
    expect(pickThumbs(rows, [])).toEqual({});
  });
});
