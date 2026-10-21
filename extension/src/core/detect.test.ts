import { describe, expect, it } from 'vitest';
import { manifestUrl, sameStream } from './detect';

describe('manifestUrl', () => {
  it('drops LL-HLS delivery directives and keeps everything else', () => {
    expect(manifestUrl('https://cam.example/live/index.m3u8?token=abc&_HLS_msn=1234&_HLS_part=2&_HLS_skip=YES')).toBe(
      'https://cam.example/live/index.m3u8?token=abc',
    );
    expect(manifestUrl('https://cam.example/live/index.m3u8')).toBe('https://cam.example/live/index.m3u8');
  });
});

describe('sameStream', () => {
  const base = 'https://cam.example/live/index.m3u8';
  it('treats cache busters and timestamps as reloads of one stream', () => {
    expect(sameStream(`${base}?_=1729500000000`, `${base}?_=1729500002000`)).toBe(true);
    expect(sameStream(base, `${base}?t=1729500002`)).toBe(true);
  });
  it('treats rotating tokens as one stream', () => {
    expect(sameStream(`${base}?id=cam1&token=a8f3k2j9d0s7l1q4`, `${base}?id=cam1&token=z9x8c7v6b5n4m3q2`)).toBe(true);
  });
  it('treats LL-HLS reloads as one stream', () => {
    expect(sameStream(`${base}?_HLS_msn=10&_HLS_part=1`, `${base}?_HLS_msn=11&_HLS_part=0`)).toBe(true);
  });
  it('keeps streams apart when a short id differs', () => {
    expect(sameStream(`${base}?cam=1`, `${base}?cam=2`)).toBe(false);
    expect(sameStream(`${base}?cam=front`, base)).toBe(false);
  });
  it('keeps different paths and hosts apart', () => {
    expect(sameStream(base, 'https://cam.example/live/other.m3u8')).toBe(false);
    expect(sameStream(base, 'https://cdn.example/live/index.m3u8')).toBe(false);
  });
});
