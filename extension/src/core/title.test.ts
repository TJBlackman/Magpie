import { describe, expect, it } from 'vitest';
import { cleanTitle, pickTitle, type PageMeta } from './title';

const empty: PageMeta = { jsonLd: [], og: '', twitter: '', metaTitle: '', doc: '', h1: '', site: '' };

describe('cleanTitle', () => {
  it('strips a trailing site name from og:site_name', () => {
    expect(cleanTitle('Building a Shed in a Weekend | Woodworks Weekly', 'Woodworks Weekly', 'https://example.org/v/1')).toBe('Building a Shed in a Weekend');
  });
  it('strips a trailing site name matched from the host', () => {
    expect(cleanTitle('(3) Lofi beats to study to - YouTube', '', 'https://www.youtube.com/watch?v=x')).toBe('Lofi beats to study to');
  });
  it('strips a leading site name', () => {
    expect(cleanTitle('Vimeo — Night Drive', '', 'https://vimeo.com/123')).toBe('Night Drive');
  });
  it('handles multi part TLDs', () => {
    expect(cleanTitle('Evening News :: BBC', '', 'https://www.bbc.co.uk/news')).toBe('Evening News');
  });
  it('keeps hyphenated words and unrelated separators', () => {
    expect(cleanTitle('Spider-Man - Official Trailer', '', 'https://example.com/')).toBe('Spider-Man - Official Trailer');
  });
  it('returns empty for a bare site name', () => {
    expect(cleanTitle('YouTube', '', 'https://www.youtube.com/')).toBe('');
  });
});

describe('pickTitle', () => {
  it('prefers JSON-LD video name, then og, then document title', () => {
    const url = 'https://example.com/watch/1';
    expect(pickTitle({ ...empty, jsonLd: ['LD Name'], og: 'OG', doc: 'Doc' }, url)).toBe('LD Name');
    expect(pickTitle({ ...empty, og: 'OG Name', doc: 'Doc' }, url)).toBe('OG Name');
    expect(pickTitle({ ...empty, twitter: 'TW', doc: 'Doc' }, url)).toBe('TW');
    expect(pickTitle({ ...empty, doc: 'Doc | Example' }, url)).toBe('Doc');
    expect(pickTitle({ ...empty, h1: 'Heading' }, url)).toBe('Heading');
  });
  it('skips sources that are only the site name', () => {
    expect(pickTitle({ ...empty, og: 'Example', doc: 'Real Video - Example' }, 'https://example.com/')).toBe('Real Video');
  });
  it('returns empty when nothing useful exists', () => {
    expect(pickTitle(empty, 'https://example.com/')).toBe('');
  });
});
