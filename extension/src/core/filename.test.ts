import { describe, expect, it } from 'vitest';
import { buildFilename, cleanSegment, guessExtension, sanitizeFilename } from './filename';

describe('cleanSegment', () => {
  it('replaces reserved characters with spaces and collapses whitespace', () => {
    expect(cleanSegment('a/b\\c:d*e?f"g<h>i|j~k', 'x')).toBe('a b c d e f g h i j k');
    expect(cleanSegment('  two   words \t here ', 'x')).toBe('two words here');
  });

  it('drops control, format, noncharacter and lone surrogate code points', () => {
    expect(cleanSegment('tab\there\u0085\u009f', 'x')).toBe('tabhere');
    expect(cleanSegment('zw\u200Bj\u200Doin\u00AD\u200E\u200F\uFEFF', 'x')).toBe('zwjoin');
    expect(cleanSegment('flag \u{1F3F4}\u{E0067}\u{E0062}\u{E007F}', 'x')).toBe('flag \u{1F3F4}');
    expect(cleanSegment('non\uFFFE\uFFFF\uFDD0char', 'x')).toBe('nonchar');
    expect(cleanSegment('lone\uD83Dsurrogate', 'x')).toBe('lonesurrogate');
    // A proper pair stays.
    expect(cleanSegment('ok \u{1F600}', 'x')).toBe('ok \u{1F600}');
  });

  it('strips dots and spaces at both ends, and guards reserved Windows names', () => {
    expect(cleanSegment('...name...', 'x')).toBe('name');
    expect(cleanSegment(' . name . ', 'x')).toBe('name');
    for (const r of ['con', 'CON', 'aux.png', 'com1', 'lpt9.txt', 'clock$', 'desktop.ini', 'Thumbs.db']) expect(cleanSegment(r, 'x')).toBe(`_${r}`);
    expect(cleanSegment('console', 'x')).toBe('console');
    expect(cleanSegment('com10', 'x')).toBe('com10');
  });

  it('cuts at max code points, never inside a pair, and trims again after the cut', () => {
    expect(cleanSegment('\u{1F600}'.repeat(130), 'x', 120)).toBe('\u{1F600}'.repeat(120));
    expect(cleanSegment(`${'a'.repeat(119)} b`, 'x', 120)).toBe('a'.repeat(119));
    expect(cleanSegment('abc', 'x', 2)).toBe('ab');
  });

  it('falls back when nothing is left', () => {
    expect(cleanSegment('', 'video')).toBe('video');
    expect(cleanSegment('...', 'video')).toBe('video');
    expect(cleanSegment('\u200D', 'video')).toBe('video');
  });
});

describe('sanitizeFilename and buildFilename', () => {
  it('sanitizeFilename is cleanSegment with the video fallback', () => {
    expect(sanitizeFilename('Harbor at Dusk: part 2')).toBe('Harbor at Dusk part 2');
    expect(sanitizeFilename('')).toBe('video');
    expect(sanitizeFilename('x'.repeat(200))).toHaveLength(120);
  });

  it('buildFilename keeps the rendition height and the right extension', () => {
    expect(buildFilename('Night Train', 'hls', undefined, '', 'https://cdn.example/m.m3u8', '854x480 · 1000 kbps')).toBe('Night Train [480p].mp4');
    expect(buildFilename('', 'file', undefined, 'image/png', 'https://i.redd.it/a.png')).toBe('i.redd.it.png');
  });

  it('guessExtension knows images', () => {
    expect(guessExtension('file', undefined, 'image/png', 'https://i.redd.it/a.png')).toBe('png');
    expect(guessExtension('file', undefined, 'image/jpeg', 'https://x/y')).toBe('jpg');
    expect(guessExtension('file', undefined, 'image/gif', 'https://i.redd.it/a.gif?x=1')).toBe('gif');
    expect(guessExtension('file', undefined, 'video/mp4', 'https://x/y')).toBe('mp4');
  });
});
