import type { HlsKey } from '../core/hls';
import { fetchBytes } from './fetcher';

const keyCache = new Map<string, Promise<CryptoKey>>();

export function sequenceIv(sequence: number): Uint8Array {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, sequence >>> 0);
  return iv;
}

export async function decryptSegment(data: Uint8Array, key: HlsKey, sequence: number, signal: AbortSignal): Promise<Uint8Array> {
  if (key.method === 'NONE') return data;
  if (key.method !== 'AES-128') throw new Error(`Unsupported key method ${key.method} (DRM?)`);
  if (!key.uri) throw new Error('AES-128 key without URI');
  let p = keyCache.get(key.uri);
  if (!p) {
    p = fetchBytes(key.uri, { signal }).then((raw) =>
      crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-CBC' }, false, ['decrypt']),
    );
    keyCache.set(key.uri, p);
  }
  const cryptoKey = await p;
  const iv = key.iv ?? sequenceIv(sequence);
  const out = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, cryptoKey, data as BufferSource);
  return new Uint8Array(out);
}
