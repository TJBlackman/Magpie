import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { assetPaths, collectRedditPosts, parsePackaged, postPath, redditAssets, type RedditPost, type RedditRaw } from './reddit';

/** Captures from reddit.com on 2026-10-28, one `shreddit-post` (or ad) element each, inline SVGs and scripts removed. */
function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/reddit/${name}.html`, import.meta.url), 'utf8');
}

function collect(html: string, url = 'https://www.reddit.com/r/comics/'): RedditRaw[] {
  return collectRedditPosts(new JSDOM(html, { url }).window.document);
}

function post(name: string): RedditPost {
  const raws = collect(fixture(name));
  expect(raws, `${name} parses to one post`).toHaveLength(1);
  return redditAssets(raws[0]!);
}

describe('collectRedditPosts', () => {
  it('reads a gallery post page: every original in slot order, plus the post facts', () => {
    const [raw] = collect(fixture('gallery'), 'https://www.reddit.com/r/comics/comments/1x4toay/the_day_all_billionaires_died/');
    expect(raw).toMatchObject({
      id: 't3_1x4toay',
      permalink: 'https://www.reddit.com/r/comics/comments/1x4toay/the_day_all_billionaires_died/',
      title: '"The day all billionaires died…"',
      subreddit: 'r/comics',
      author: 'thisecommercelife',
      type: 'gallery',
      contentHref: 'https://www.reddit.com/gallery/1x4toay',
      playerSrc: '',
      packaged: '',
    });
    expect(raw!.gallery).toHaveLength(20);
    expect(raw!.gallery[0]).toBe('https://i.redd.it/ktgekf69v7vh1.png');
    expect(raw!.gallery[19]).toBe('https://i.redd.it/g79cuk69v7vh1.png');
    expect(new Set(raw!.gallery).size).toBe(20);
    expect(raw!.images).toEqual([]);
    expect(raw!.preview).toMatch(/^https:\/\/preview\.redd\.it\/.*width=320/);
  });

  it('skips ads, which are shreddit-ad-post elements', () => {
    expect(collect(fixture('ad-video'))).toEqual([]);
    expect(collect(fixture('ad-gallery'))).toEqual([]);
    expect(collect(`${fixture('image')}${fixture('ad-video')}${fixture('gif')}`)).toHaveLength(2);
  });

  it('reads an image post', () => {
    const [raw] = collect(fixture('image'));
    expect(raw).toMatchObject({ id: 't3_1xhnxk5', type: 'image', contentHref: 'https://i.redd.it/lzrh2o1nl7yh1.png', subreddit: 'r/wallpaper' });
    expect(raw!.images).toEqual(['https://i.redd.it/lzrh2o1nl7yh1.png']);
    expect(raw!.gallery).toEqual([]);
  });

  it('reads a GIF post: the original is the content href, the player plays a capped MP4', () => {
    const [raw] = collect(fixture('gif'));
    expect(raw).toMatchObject({ type: 'gif', contentHref: 'https://i.redd.it/7ovuvqmuu2yh1.gif' });
    expect(raw!.playerSrc).toMatch(/^https:\/\/preview\.redd\.it\/7ovuvqmuu2yh1\.gif\?width=960&format=mp4/);
  });

  it('reads a video post: the HLS master and the packaged MP4 list', () => {
    const [raw] = collect(fixture('video'));
    expect(raw).toMatchObject({ type: 'video', contentHref: 'https://v.redd.it/m97uvy6cd2yh1' });
    expect(raw!.playerSrc).toMatch(/^https:\/\/v\.redd\.it\/m97uvy6cd2yh1\/HLSPlaylist\.m3u8\?/);
    expect(parsePackaged(raw!.packaged).map((p) => p.height)).toEqual([1080, 720, 480, 360, 270, 220]);
    expect(raw!.preview).toMatch(/^https:\/\/external-preview\.redd\.it\//);
  });

  it('reads a crosspost through the post it embeds', () => {
    const [raw] = collect(fixture('crosspost'));
    expect(raw).toMatchObject({ type: 'crosspost', permalink: 'https://www.reddit.com/r/LivingBackgrounds/comments/1xegbiv/found_on_scryr_faerie/' });
    expect(raw!.playerSrc).toMatch(/^https:\/\/v\.redd\.it\/kf1pfd13v1xh1\/HLSPlaylist\.m3u8/);
    expect(parsePackaged(raw!.packaged).length).toBeGreaterThan(0);
  });

  it('finds nothing on a page without posts', () => {
    expect(collect('<html><body><h1>Hello</h1></body></html>')).toEqual([]);
  });
});

describe('redditAssets', () => {
  it('gallery: one file per item, in order', () => {
    const p = post('gallery');
    expect(p.id).toBe('1x4toay');
    expect(p.subreddit).toBe('comics');
    expect(p.summary).toBe('Gallery, 20 images');
    expect(p.assets).toHaveLength(20);
    expect(p.assets[0]).toEqual({ url: 'https://i.redd.it/ktgekf69v7vh1.png', kind: 'file', mime: 'image/png', label: '1 of 20 · PNG' });
    expect(p.assets[19]!.label).toBe('20 of 20 · PNG');
    expect(p.note).toBeUndefined();
  });

  it('animated gallery: GIF originals, not the preview MP4s', () => {
    const p = post('gallery-gif');
    expect(p.summary).toBe('Gallery, 2 GIFs');
    expect(p.assets.map((a) => a.url)).toEqual(['https://i.redd.it/f0751buy2fxh1.gif', 'https://i.redd.it/9ci84cuy2fxh1.gif']);
    expect(p.assets[0]!.mime).toBe('image/gif');
  });

  it('image: the original', () => {
    const p = post('image');
    expect(p.summary).toBe('Image, PNG');
    expect(p.assets).toEqual([{ url: 'https://i.redd.it/lzrh2o1nl7yh1.png', kind: 'file', mime: 'image/png', label: 'Image · PNG' }]);
  });

  it('gif: the original GIF, never the capped MP4 the player uses', () => {
    const p = post('gif');
    expect(p.summary).toBe('GIF');
    expect(p.assets).toEqual([{ url: 'https://i.redd.it/7ovuvqmuu2yh1.gif', kind: 'file', mime: 'image/gif', label: 'GIF · GIF' }]);
  });

  it('video: the largest packaged MP4, which carries its audio', () => {
    const p = post('video');
    expect(p.summary).toBe('Video 1080p');
    expect(p.assets).toHaveLength(1);
    expect(p.assets[0]).toMatchObject({ kind: 'file', mime: 'video/mp4', label: '1080p · MP4 with audio' });
    expect(p.assets[0]!.url).toMatch(/^https:\/\/packaged-media\.redd\.it\/m97uvy6cd2yh1\/pb\/m2-res_1080p\.mp4\?/);
  });

  it('video without packaged MP4s: the HLS master at best quality', () => {
    const raws = collect(fixture('video'));
    const p = redditAssets({ ...raws[0]!, packaged: '' });
    expect(p.summary).toBe('Video');
    expect(p.assets[0]).toMatchObject({ kind: 'hls', label: 'HLS, best quality' });
    expect(p.assets[0]!.url).toMatch(/HLSPlaylist\.m3u8/);
    expect(redditAssets({ ...raws[0]!, packaged: '{broken' }).assets[0]!.kind).toBe('hls');
  });

  it('crosspost: the embedded post, said so', () => {
    const p = post('crosspost');
    expect(p.summary).toBe('Crosspost, video 720p');
    expect(p.assets[0]!.url).toMatch(/kf1pfd13v1xh1/);
  });

  it('link and text posts have nothing to save, and say so', () => {
    const base: RedditRaw = { id: 't3_abc', permalink: 'https://www.reddit.com/r/x/comments/abc/t/', title: 't', subreddit: 'r/x', author: 'a', type: 'link', contentHref: 'https://example.com/a', gallery: [], images: [], playerSrc: '', packaged: '', preview: '' };
    expect(redditAssets(base)).toMatchObject({ assets: [], summary: 'Link', note: 'Not hosted on Reddit. Nothing to save here.' });
    expect(redditAssets({ ...base, type: 'text', contentHref: '' })).toMatchObject({ assets: [], summary: 'Text post' });
  });

  it('a hosted post whose files are missing from the markup says the page changed', () => {
    const base: RedditRaw = { id: 't3_abc', permalink: 'https://www.reddit.com/r/x/comments/abc/t/', title: 't', subreddit: 'r/x', author: 'a', type: 'gallery', contentHref: 'https://www.reddit.com/gallery/abc', gallery: [], images: [], playerSrc: '', packaged: '', preview: '' };
    const p = redditAssets(base);
    expect(p.assets).toEqual([]);
    expect(p.summary).toBe('Gallery');
    expect(p.note).toMatch(/Reddit changed its page/);
  });
});

describe('assetPaths', () => {
  it('one file goes under the subreddit, named after the post', () => {
    const p = post('image');
    expect(assetPaths(p)).toEqual(['Reddit/wallpaper/Glau Pass [3840x2160] [1xhnxk5].png']);
    expect(postPath(p)).toBe('Reddit/wallpaper/Glau Pass [3840x2160] [1xhnxk5].png');
  });

  it('a gallery gets a folder with numbered files', () => {
    const p = post('gallery');
    const paths = assetPaths(p);
    expect(paths[0]).toBe('Reddit/comics/The day all billionaires died… [1x4toay]/01.png');
    expect(paths[19]).toBe('Reddit/comics/The day all billionaires died… [1x4toay]/20.png');
    expect(postPath(p)).toBe('Reddit/comics/The day all billionaires died… [1x4toay]');
  });

  it('an HLS asset saves as mp4, and reserved characters leave every segment', () => {
    const p: RedditPost = { id: 'a1', permalink: '', title: 'Who: me? <yes>', subreddit: 'r/odd', author: 'x', type: 'video', preview: '', summary: '', assets: [{ url: 'https://v.redd.it/a1/HLSPlaylist.m3u8?x=1', kind: 'hls', mime: '', label: '' }] };
    expect(assetPaths(p)).toEqual(['Reddit/r odd/Who me yes [a1].mp4']);
  });

  it('a post without a subreddit goes under the author', () => {
    const p: RedditPost = { id: 'a1', permalink: '', title: 't', subreddit: '', author: 'someone', type: 'image', preview: '', summary: '', assets: [{ url: 'https://i.redd.it/a.jpg', kind: 'file', mime: 'image/jpeg', label: '' }] };
    expect(assetPaths(p)).toEqual(['Reddit/someone/t [a1].jpg']);
  });
});
