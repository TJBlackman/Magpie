import { describe, expect, it } from 'vitest';
import { parseAttributes, parseHls } from './hls';
import { detect } from './detect';

describe('parseAttributes', () => {
  it('handles quoted and bare values', () => {
    expect(parseAttributes('BANDWIDTH=1280000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"')).toEqual({
      BANDWIDTH: '1280000',
      RESOLUTION: '1280x720',
      CODECS: 'avc1.4d401f,mp4a.40.2',
      AUDIO: 'aud',
    });
  });
});

describe('parseHls', () => {
  it('parses a master playlist', () => {
    const p = parseHls(
      `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360/index.m3u8`,
      'https://cdn.example/v/master.m3u8',
    );
    expect(p.kind).toBe('master');
    if (p.kind !== 'master') return;
    expect(p.variants).toHaveLength(2);
    expect(p.variants[0]!.uri).toBe('https://cdn.example/v/720/index.m3u8');
    expect(p.variants[0]!.audio).toBe('aud');
    expect(p.renditions[0]!.uri).toBe('https://cdn.example/v/audio/index.m3u8');
  });

  it('parses a media playlist with map, key, byterange', () => {
    const p = parseHls(
      `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000@0
seg.m4s
#EXTINF:3.5,
#EXT-X-BYTERANGE:500
seg.m4s
#EXT-X-ENDLIST`,
      'https://cdn.example/v/720/index.m3u8',
    );
    expect(p.kind).toBe('media');
    if (p.kind !== 'media') return;
    expect(p.endList).toBe(true);
    expect(p.container).toBe('fmp4');
    expect(p.segments).toHaveLength(2);
    expect(p.segments[0]!.sequence).toBe(10);
    expect(p.segments[0]!.map?.uri).toBe('https://cdn.example/v/720/init.mp4');
    expect(p.segments[0]!.key.method).toBe('AES-128');
    expect(p.segments[0]!.key.iv?.[15]).toBe(0x0f);
    expect(p.segments[1]!.byteRange).toEqual({ length: 500, offset: 1000 });
    expect(p.totalDuration).toBeCloseTo(7.5);
  });
});

describe('detect', () => {
  it('flags manifests by mime or extension', () => {
    expect(detect({ url: 'https://a/b/master.m3u8', mime: 'application/octet-stream', resourceType: 'xmlhttprequest', contentLength: 100 })).toBe('hls');
    expect(detect({ url: 'https://a/b/x?y=1', mime: 'application/vnd.apple.mpegurl', resourceType: 'xmlhttprequest', contentLength: 100 })).toBe('hls');
    expect(detect({ url: 'https://a/b/m.mpd', mime: 'application/dash+xml', resourceType: 'xmlhttprequest', contentLength: 100 })).toBe('dash');
  });
  it('ignores segments and small xhr video', () => {
    expect(detect({ url: 'https://a/seg001.ts', mime: 'video/mp2t', resourceType: 'xmlhttprequest', contentLength: 5e6 })).toBeNull();
    expect(detect({ url: 'https://a/chunk-1.m4s', mime: 'video/mp4', resourceType: 'xmlhttprequest', contentLength: 5e6 })).toBeNull();
    expect(detect({ url: 'https://a/clip.mp4', mime: 'video/mp4', resourceType: 'xmlhttprequest', contentLength: 1e5 })).toBeNull();
  });
  it('flags <video src> and big xhr files', () => {
    expect(detect({ url: 'https://a/clip.mp4', mime: 'video/mp4', resourceType: 'media', contentLength: null })).toBe('file');
    expect(detect({ url: 'https://a/clip.mp4', mime: 'video/mp4', resourceType: 'xmlhttprequest', contentLength: 5e7 })).toBe('file');
  });
});
