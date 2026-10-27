# Plan: HLS separate audio merge and DASH download

Status: revision 3, 2026-10-27. Phases A to D implemented on branch feature/dash-altaudio; review fixes in progress. Kept as the design record.

Two website rows say "Soon": DASH, and HLS with a separate audio track. They share one missing piece. DASH always serves video and audio as separate tracks, so DASH download is impossible without a two track merge. Build the merge first against the HLS alt audio fixture, then DASH static on top, then TS and ADTS pairs, then DASH live.

## What exists today

- `src/core/hls.ts` parses masters (variants, EXT-X-MEDIA renditions) and media playlists into `HlsMedia` (segments with uri, byteRange, key, map, duration).
- `engine.inspect` resolves each variant's audio rendition into `Variant.audioUri` (today: the first rendition in the group with a URI, not DEFAULT) and adds a "video only for those" note.
- `engine.downloadHls` pulls one playlist through `orderedPool` (4 in flight, 12 ahead) into a `Sink`: `passthroughSink` for fMP4, `tsSink` (mux.js) for TS.
- `mux.ts` has `Timeline` (per track tfdt rebase, shared second offset, elst lead trim, sidx to free), `patchDurations`, and a `boxes` iterator. These are the building blocks for a two track merge.
- DASH: sniffer tags `.mpd` and `application/dash+xml` as `kind: 'dash'`; `inspect` and `thumbnail` refuse it, and `background.ts` skips inspecting and thumbnailing dash candidates (lines 97 and 144). The fixture is a static MPD with SegmentTemplate $Number$, two video representations, one audio. The e2e test asserts the refusal.
- Fixture facts checked on disk (author and reviewer): every init carries track id 1 in tkhd and trex, mvhd next_track_ID 2, every trak has an elst (HLS video `[21/-1, 0/0]`, HLS audio `[0/0]`, DASH video `[0/0]`, DASH audio `[0/1024]`), fragments set tfhd flags 0x20038 (default-base-is-moof on, no base_data_offset). The DASH audio has 6 chunks and the video 5, and ceil(20 s / 4 s) = 5, so the MPD never lists the sixth audio chunk.

## Verified by prototype

The reviewer built a throwaway Node script doing exactly what D1 describes (joined moov, audio trak renumbered to id 2, tfhd id rewritten, sidx to free, styp kept) and ran it on both fixtures:

- ffprobe: one video and one audio stream, start times 21 ms apart.
- Video decoded frames match `ref/720.framemd5` 600 of 600 for HLS and DASH.
- Audio encoded packet hashes match the source 939 of 939.
- Chrome stable and Playwright Chromium play both files to the end. Firefox not checked yet.

So the core idea is sound. The rest of this document is about doing it in the engine without breaking the cases the prototype did not cover.

## Design decisions

### D1. Merge at the fragment level, no mp4box.js, no ffmpeg.wasm

Both inputs are fragmented MP4 with one track each. The output is one fMP4 whose moov holds both traks and both trex entries, followed by the original moof+mdat pairs from both streams interleaved by playlist time. Each moof keeps its single traf. With default-base-is-moof set, or no base_data_offset at all (implicit base is the moof start when a moof has one traf, ISO 14496-12 8.8.7.1), fragments copy verbatim. An explicit base_data_offset (tfhd flag 0x1) is rewritten to the output offset, which is known at write time, so nothing is refused for it.

Rejected: mp4box.js (needs all samples to build a flat moov, large dependency); ffmpeg.wasm (30 MB, 2 GB memory ceiling, breaks long recordings).

### D2. One `mergeSink` that owns both tracks

```ts
export function mergeSink(write: Write, durationSec: number): MergeSink
interface MergeSink {
  /** Both inits before any fragment. Builds and writes the joined moov once. */
  setInits(video: Uint8Array, audio: Uint8Array): Promise<void>
  push(side: 'video' | 'audio', fragment: Uint8Array): Promise<void>
  flush(): Promise<void>
  readonly firstInit: Uint8Array | null
}
```

Joined init construction (`joinInits(video, audio)`):

1. ftyp from the video init.
2. moov = video mvhd, every video trak, the audio trak renumbered, mvex with the video mehd (if any), the video trex entries, the audio trex renumbered, then udta from the video init. Audio track id = 1 + max video track id. mvhd next_track_ID = audio id + 1. Box sizes recomputed up the chain with a small `box(type, ...children)` builder over the existing `boxes` iterator.
3. Rescale the audio trak to the video's movie timescale: tkhd duration and elst segment_duration are in movie timescale, and a mux.js video init uses 90000 where ffmpeg uses 1000. Without this an audio lead of 21 ms becomes 0.23 ms.
4. Renumber tkhd and trex track_ID in the audio boxes. Renumbering applies to every audio side, including a mux.js produced one whose track id is 0.
5. `Timeline.learn` on the joined init, `fixInit` left as is (it keeps the fixture's real 21 ms video lead and would otherwise reintroduce the AAC priming frame on DASH audio), then `patchDurations`.

Per fragment: rewrite tfhd track_ID to the renumbered id before `Timeline.rebase`, rewrite mfhd sequence_number to a running count across both sides (validators reject duplicates; players do not care), rewrite base_data_offset when flag 0x1 is set. Then `rebase` does what it does today (tfdt shift, sidx to free).

Timeline anchor: `rebase` sets the shared start second from the first fragment per track, so a later track with an earlier start would get a different shift. Add `Timeline.anchor(startSec)`; the engine calls it with the smaller of the two first fragment start times before writing anything. `startOf(side, fragment)` reads tfdt and looks up the timescale by side, not by track id, because both sides are track 1 until renumbered.

The sink does not buffer. Ordering is the engine's job (D3).

### D3. Engine: `downloadPair`

```ts
private async downloadPair(video: HlsMedia, audio: HlsMedia, write, job, candidate, signal)
```

- Order by playlist time, not tfdt: each segment's start is the running EXTINF sum (HLS) or the segment start from the template or timeline (DASH). tfdt is used only for rebasing. tfdt ordering breaks on EXT-X-DISCONTINUITY (SSAI from MediaTailor, Google DAI, Brightcove), where the clock resets and `rebase` would clamp to 0.
- Refuse, with a clear message, a pair where either side has a discontinuity or more than one EXT-X-MAP. `passthroughSink` can write a new init mid file for a single stream; a joined moov cannot be rewritten. Single stream downloads keep today's behaviour.
- Two `orderedPool`s, video with 4 in flight and audio with 2 (changed after review: audio is a few percent of the bytes, and halving the video side halved throughput). Each side has its own `initLoader`. Keys per segment via `decryptSegment`, so an audio rendition with its own EXT-X-KEY works.
- Header rules: reuse the `allow()` helper from `recordLive` for the audio playlist host, audio segment host, audio init host and key hosts. Today `run()` only covers `variant.uri` and `segments[0]` of the video side.
- A child `AbortController` for the pair, aborted in `finally`, so a failure on one side stops the other side's in flight fetches instead of leaving unhandled rejections.
- Loop: hold `nextV` and `nextA` (fetched, decrypted). Push whichever playlist start is smaller, refill that side, ties to video. Drain the remaining side at the end.
- Progress weighted by seconds: `job.segmentsTotal` stays the video count and `segmentsDone` the video index, with audio contributing to `bytes` only. Counting audio segments equally would skew percent and ETA since they are about 3% of the bytes.
- Duration for history: the video playlist's `totalDuration`.
- Where to branch: live is only known after fetching the video playlist, so the pair branch sits after that fetch in `run()`: `variant.audioUri && media.endList`.

### D4. Variant and audio rendition selection

- Rule: take the DEFAULT=YES rendition of the variant's AUDIO group, else the first AUTOSELECT=YES, else the first. If that rendition has no URI, the main audio is muxed into the variant and nothing is merged, even if other renditions in the group have URIs (those are dubs). Today's code picks the first with a URI, which would merge a dub over muxed main audio; that is a bug to fix in the same change.
- Label the variant with the audio name or language when a merge will happen: `1280x720 · 2280 kbps · avc1... + English`.
- The sheet note becomes "Audio: English (default). Other languages are not selectable yet." A language picker is a follow up.
- The "v1 saves video only" note stays only for combinations still refused (live, discontinuities, second map, TS or ADTS until phase C), worded to say which.

### D5. Live HLS with separate audio: not in this plan

`recordLive` polls one playlist. A paired live recording would poll two, align them, and handle one side falling behind. Keep video only with a note for live masters that use alt audio. The website should say "live streams with separate audio record video only".

### D6. DASH parser in `src/core/dash.ts`, output shaped like `HlsMedia`

The parser emits per representation the shape `downloadHls` and `downloadPair` already consume: segments with uri, byteRange, map, key NONE, duration and start, plus totalDuration, container fmp4, endList true. Rename `HlsMedia` to `MediaPlaylist` (keep the alias for a release). DASH then reuses pools, sinks, timeline, OPFS writer, save and archive without a second download loop. `run()` must not call `fetchText` plus `parseHls` on an MPD, so `Queued` carries a `kind` and the parsed representation lists.

Parse with `DOMParser`, which both engine hosts have. Walk `children` by `localName` so namespaces and prefixes do not matter. Unit tests run under jsdom (`// @vitest-environment jsdom`, works with the current config), not happy-dom: happy-dom 21 is case insensitive on `getElementsByTagName` in XML and returns nothing for `getElementsByTagNameNS`, so tests could pass on code that fails in the extension.

Supported in v1 (static):

- `MPD@type="static"`, `mediaPresentationDuration`, or `Period@duration` when the MPD has none.
- Periods: pick the longest Period, not the first. Multi Period VOD is the normal output of server side ad insertion and Period 1 is usually a preroll. Note which Period was chosen and how many there were.
- `BaseURL` at MPD, Period, AdaptationSet and Representation levels, resolved in order against the manifest URL. Several BaseURLs at one level: take the first.
- AdaptationSet by `contentType` or `mimeType` prefix on the set or on its Representations. Text and image sets ignored. A set with an `EssentialProperty` whose scheme is unknown is discarded per spec, which also keeps trick mode sets (`http://dashif.org/guidelines/trickmode`) out of the variant list and away from thumbnails.
- Attributes inherited from the set when absent on the Representation: `mimeType`, `codecs`, `width`, `height`, `frameRate`, `audioSamplingRate`.
- Representations with `video/webm` or `audio/webm` are filtered out of the list; if nothing remains, inspect fails with "WebM DASH is not supported".
- Muxed representations (`codecs="avc1...,mp4a..."` with no audio set) go through `downloadHls` alone.
- `SegmentTemplate` inherited per attribute across Period, AdaptationSet and Representation (Representation value wins per attribute, not per element). `$RepresentationID$`, `$Bandwidth$`, `$Number$`, `$Time$`, the `%0Nd` width form and `$$` escape, `startNumber`, `endNumber`, `timescale`, `duration`, `presentationTimeOffset`, `initialization`, `Initialization@sourceURL`. Segment count for the duration form is ceil(periodDuration / segmentDuration), and a 404 on the final numbered segment only is tolerated (packagers disagree on rounding).
- `SegmentTimeline` with `S@t`, `S@d`, `S@r` including r = -1.
- `SegmentBase` with `Initialization@range` and `indexRange`: fetch the index range, parse the sidx into byte range segments (about 40 lines), and emit them as ordinary segments with the init range as the map. No whole file download: that would write the file's own moov after the init, hold the whole file in memory, and break the thumbnail path.
- `SegmentList` with `SegmentURL@media` and `@mediaRange`.
- Encryption: `ContentProtection` on the set or the Representation refuses with "This stream uses DRM". Also sniff the chosen inits for `encv`, `enca` or `pssh` and refuse, since some MPDs omit ContentProtection.
- `xlink:href` on Period or sets: refuse with a note.

Inspection output: one Variant per video Representation sorted by bandwidth, labelled like HLS, each carrying the chosen audio: prefer an AdaptationSet with `Role@value="main"`, else the first audio set; within it prefer `mp4a` codecs over `ec-3` and `ac-3` (Chrome cannot decode E-AC-3, so the saved file would be silent there), then highest bandwidth. No page language matching: the engine has no reliable source for it. Audio only MPDs produce one audio variant, download through `downloadHls`, and save as `.m4a`.

Children: put every chosen representation media URL (and for SegmentBase the whole file URLs) into `inspection.children` so the sniffer folds them under the MPD row. Players fetch SegmentBase files as `video_720.mp4` with Range requests, which `detect` would otherwise list as plain file rows beside the MPD. `background.ts` must inspect dash manifests on sight, as it does for HLS, for the folding to happen.

### D7. DASH live (type="dynamic")

Phase D, after static and the TS pairs. Sketch:

- `inspection.live` comes from `type="dynamic"`, not reload counts: a dynamic MPD without `minimumUpdatePeriod` is never reloaded.
- Segment availability from `availabilityStartTime`, `Period@start`, `timeShiftBufferDepth`, `suggestedPresentationDelay`, `minimumUpdatePeriod`. Implement `UTCTiming` for `http-xsdate` and `http-iso` (a few lines); a local clock off by one segment means 404s at the live edge.
- $Number$ form: current number = floor((now - AST - periodStart - lead) / segDuration) + startNumber. SegmentTimeline form: the last S entries, like HLS media sequence tracking.
- Reload the MPD every `minimumUpdatePeriod`, append new segments per side through the same two way merge, end on Stop or when the MPD turns static.
- Test server gets a `/live-dash/<session>/` simulator like `liveSim`, rewriting `availabilityStartTime` to the session start.

### D8. Thumbnails for DASH

`hlsSample` becomes `sample(candidate)`: for DASH, the lowest bandwidth video representation (trick mode sets already excluded), init plus the first segment through `passthroughSink`. Remove the dash skip in `background.ts` line 144 and in `engine.thumbnail`. The README line "DASH streams ... keep the kind icon" goes.

### D9. Audio verification in e2e

Decoded audio frame hashes cannot be compared against `src/720.mp4`: its edit list drops the AAC priming frame (938 decoded frames) while the HLS audio rendition keeps it (939) and the DASH audio has a different elst. Encoded packet hashes do match exactly, so:

- `gen.sh` writes `ref/audio.packets` from `src/720.mp4` with `-map 0:a -c copy -f framemd5`, hash column only.
- `expectAudioMatch(file)` compares the file's audio packet hashes to that list: exact for HLS, prefix with at most one missing packet for DASH (the sixth audio chunk is never listed by the MPD), the same shape as the existing prefix tolerance in `fixtures.ts`.
- ffprobe asserts exactly one video and one audio stream and that their start times differ by under 50 ms.

### D10. Step 0: merge CLI

Before touching the engine, a Node script under `scripts/` (or `e2e/`) that calls the real `joinInits` and `mergeSink` on fixture inits and segments, writes an MP4, and runs the ffprobe and packet checks. The reviewer's 40 line prototype found every structural issue above; keeping a maintained version makes `mux.ts` changes checkable in seconds without the extension.

## Phases and order

### Phase A: HLS separate audio, fMP4 pair

1. `mux.ts`: `joinInits`, audio trak rescale, `renumberTrack`, mfhd renumber, base_data_offset rewrite, `Timeline.anchor`, `mergeSink`, `startOf`. Unit tests on synthetic boxes plus the real fixture inits when present on disk (skip when `testsite/public/media` is missing).
2. Step 0 CLI (D10) and run it on both fixtures.
3. `engine.ts`: `downloadPair` per D3, rendition rule per D4, header rules for every audio host, child abort controller, discontinuity and second map refusal.
4. `types.ts`: `Variant.audioLabel`; `Job` unchanged.
5. UI: sheet note text.
6. Fixtures: `gen.sh` adds `ref/audio.packets`.
7. e2e: `hls altaudio: video and audio merged` with frame, packet and ffprobe checks on Chrome; the Firefox smoke gets the same case, which is also the first Firefox playback check of a merged file.
8. Website row: "HLS with a separate audio track" becomes supported, with "fMP4 only, live records video only" in the detail.

Exit criteria: 600 of 600 frames and 939 of 939 audio packets on Chrome and Firefox.

### Phase B: DASH static

1. `core/dash.ts` parser with unit tests under jsdom against: the ffmpeg fixture MPD, a SegmentTimeline MPD, a SegmentBase MPD, Period level SegmentTemplate with set level attributes (Unified Streaming shape), multi BaseURL, multi Period with a short preroll, ContentProtection, EssentialProperty trick mode, WebM, muxed representation, audio only. Fixtures: `gen.sh` adds `dash-timeline` (`-use_timeline 1`) and `dash-single` (`-single_file 1`); the rest are hand written MPDs in the test file.
2. sidx parser for SegmentBase.
3. `engine.inspect` for dash, `Queued` carries parsed lists, `run()` routes to `downloadPair` or `downloadHls`, DRM sniff on the inits.
4. Thumbnail sample for dash; `background.ts` inspects and thumbnails dash candidates.
5. Children folding for representation URLs.
6. e2e: replace the refusal test with `dash: picks 360p, merges audio` and a 720p run, plus SegmentTimeline and SegmentBase pages, frame, packet and ffprobe checks. Archive tests get a `kind: 'dash'` entry.
7. README table and website row.

### Phase C: TS video and ADTS audio pairs

Separate phase because every assumption here needs a spike first:

- `tsSink` has to become a producer of init plus fragments instead of writing to `Write`, run with `remux: false` and `keepOriginalTimestamps: true` (both confirmed in mux.js source: separate per track `data` events with their own init, and tfdt on the source 90 kHz clock).
- Drop the `type: 'audio'` events a TS video segment with muxed audio produces.
- mux.js's AAC track has no id, so its tkhd, trex and tfhd carry 0; renumbering handles it. mux.js mvhd timescale is 90000 and next_track_ID is 0xffffffff; the join rescales per D2 step 3.
- ADTS timing comes only from ID3 PRIV timestamps in the packed audio segments.
- Fixture: ffmpeg `-hls_segment_type mpegts` writes TS for the audio rendition too (reviewer checked, the `.aac` file starts with 0x47), so a packed ADTS fixture needs another tool (Bento4 or a small script). TS audio renditions, which ffmpeg does produce, are the first target; ADTS second.

Until this phase ships the website says "fMP4 only".

### Phase D: DASH live

Per D7, with its own fixture, server simulator, and e2e case modeled on `live.spec.ts`.

## Risks still open

- R1. Firefox playback of a two track fMP4 with one traf per moof is unverified until Phase A step 7.
- R2. Timeline shift floors seconds per timescale, so sub millisecond offsets differ between tracks. The ffprobe 50 ms check bounds it.
- R3. Player compatibility beyond Chrome and ffmpeg (VLC, Windows Media Player, QuickTime): manual check list in the PR.
- R4. `patchDurations` writes the same duration into every tkhd; audio a little longer or shorter than video shows the video length. Acceptable.
- R5. History matching for `.mpd` URLs follows the HLS rules unchanged. Verify archive tests with dash entries.
- R6. Phase B parser scope is wide; real site MPDs will still surprise. Keep the refusal messages specific so the sheet says what was unsupported.

## Not in this plan

Language picker for audio, subtitle download, DASH multi Period concatenation, ClearKey, xlink resolution, WebM DASH, live HLS with separate audio, pause and resume, filename templates.
