// Shared player bootstrap. data-src on the <video> decides the player:
//   .m3u8 -> hls.js, .mpd -> dash.js, anything else -> native src.
// Exposes window.__magpieReady (true once playback started) for tests.
(async () => {
  const video = document.querySelector('video');
  const status = document.getElementById('status');
  const say = (m) => { if (status) status.textContent = m; };
  let src = video.dataset.src;
  if (video.dataset.srcApi) {
    const r = await fetch(video.dataset.srcApi);
    src = (await r.json()).playlist;
  }
  window.__magpieReady = false;
  video.addEventListener('playing', () => { window.__magpieReady = true; say('playing ' + src); }, { once: true });
  video.addEventListener('error', () => say('video error ' + (video.error && video.error.message)));

  if (src.endsWith('.m3u8') || video.dataset.player === 'hls') {
    await load('/vendor/hls.js');
    const hls = new Hls({ enableWorker: false });
    hls.on(Hls.Events.ERROR, (_, d) => say('hls error ' + d.type + ' ' + d.details));
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
  } else if (src.endsWith('.mpd')) {
    await load('/vendor/dash.js');
    const p = dashjs.MediaPlayer().create();
    p.initialize(video, src, true);
  } else {
    video.src = src;
    video.play().catch(() => {});
  }

  function load(url) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = url; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
})();
