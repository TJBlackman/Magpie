// Magpie test site. Serves the fixture matrix with the behaviours the
// extension has to cope with: plain static files, cookie and Referer gated
// media, and a "hidden" case where the manifest has no extension and a
// misleading content type.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8787", "listen address")
	root := flag.String("root", defaultRoot(), "testsite directory (contains public/ and node_modules/)")
	flag.Parse()

	public := filepath.Join(*root, "public")
	media := filepath.Join(public, "media")
	if _, err := os.Stat(filepath.Join(media, "src", "720.mp4")); err != nil {
		log.Printf("WARNING: fixtures missing at %s. Run: bash testsite/fixtures/gen.sh", media)
	}

	mux := http.NewServeMux()

	// Vendor players straight out of node_modules so versions are pinned by package.json.
	nm := filepath.Join(*root, "node_modules")
	mux.Handle("/vendor/hls.js", noCache(serveFile(filepath.Join(nm, "hls.js", "dist", "hls.min.js"))))
	mux.Handle("/vendor/dash.js", noCache(serveFile(filepath.Join(nm, "dashjs", "dist", "modern", "umd", "dash.all.min.js"))))

	// Gated media: same files as hls-ts but the server demands the session
	// cookie the page set and a Referer from this site.
	mux.Handle("/gated/media/", gate(http.StripPrefix("/gated/media/", http.FileServer(http.Dir(filepath.Join(media, "hls-ts"))))))
	mux.HandleFunc("/gated.html", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "magpie_session", Value: "let-me-in", Path: "/", SameSite: http.SameSiteLaxMode})
		http.ServeFile(w, r, filepath.Join(public, "gated.html"))
	})

	// Hidden: manifest served from an API style URL with a bogus content type,
	// segments from opaque ids. Only MSE capture (phase 3) can catch this one.
	mux.HandleFunc("/hidden/api/stream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"playlist":"/hidden/api/playlist?id=abc123"}`)
	})
	mux.HandleFunc("/hidden/api/playlist", func(w http.ResponseWriter, r *http.Request) {
		data, err := os.ReadFile(filepath.Join(media, "hls-fmp4", "720p", "index.m3u8"))
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		text := string(data)
		text = strings.ReplaceAll(text, "init.mp4", "/hidden/api/blob?k=init")
		for i := 0; i < 100; i++ {
			text = strings.ReplaceAll(text, fmt.Sprintf("seg%03d.m4s", i), fmt.Sprintf("/hidden/api/blob?k=%d", i))
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		fmt.Fprint(w, text)
	})
	mux.HandleFunc("/hidden/api/blob", func(w http.ResponseWriter, r *http.Request) {
		k := r.URL.Query().Get("k")
		name := "init.mp4"
		if k != "init" {
			name = fmt.Sprintf("seg%s.m4s", padLeft(k, 3))
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeFile(w, r, filepath.Join(media, "hls-fmp4", "720p", name))
	})

	// Slow: the media tree throttled to about 2 MB/s per request, so progress
	// bars and the download queue can be watched mid flight.
	mux.Handle("/slow/", noCache(withMime(throttle(http.StripPrefix("/slow/", http.FileServer(http.Dir(media))), 2<<20))))
	// Crawl: the same at about 200 KB/s, so a download stays running for half a
	// minute while a test clicks around it.
	mux.Handle("/crawl/", noCache(withMime(throttle(http.StripPrefix("/crawl/", http.FileServer(http.Dir(media))), 200<<10))))

	// Live: the hls-ts clip, and an fMP4 rendition whose timestamps start hours
	// in, replayed as live streams, see liveSim.
	mux.Handle("/live/", noCache(withMime(&liveSim{prefix: "/live/", dir: filepath.Join(media, "hls-ts"), starts: map[string]time.Time{}})))
	mux.Handle("/live-fmp4/", noCache(withMime(&liveSim{prefix: "/live-fmp4/", dir: filepath.Join(media, "hls-live-fmp4"), starts: map[string]time.Time{}})))
	// The hls-ts clip with ads stitched in the way Twitch does it, see liveSim.
	mux.Handle("/live-ads/", noCache(withMime(&liveSim{prefix: "/live-ads/", dir: filepath.Join(media, "hls-ts"), ads: filepath.Join(media, "ad"), starts: map[string]time.Time{}})))
	// Live DASH: the dash fixture replayed as a dynamic MPD, see dashLiveSim.
	// Its UTCTiming element points players and the recorder at /time.
	mux.Handle("/live-dash/", noCache(withMime(&dashLiveSim{prefix: "/live-dash/", dir: filepath.Join(media, "dash"), starts: map[string]time.Time{}})))
	// The same with the dash-timeline fixture: a $Time$ SegmentTimeline whose S
	// entries slide with the window while startNumber stays 1, see timelineMPD.
	mux.Handle("/live-dash-timeline/", noCache(withMime(&dashLiveSim{prefix: "/live-dash-timeline/", dir: filepath.Join(media, "dash-timeline"), starts: map[string]time.Time{}, timeline: true})))
	mux.Handle("/time", noCache(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		fmt.Fprint(w, xsDateTime(time.Now()))
	})))

	mux.Handle("/", noCache(withMime(http.FileServer(http.Dir(public)))))

	log.Printf("magpie testsite on http://%s (root %s)", *addr, *root)
	log.Fatal(http.ListenAndServe(*addr, logRequests(mux)))
}

func defaultRoot() string {
	exe, _ := os.Executable()
	for _, c := range []string{filepath.Dir(exe), "."} {
		for _, up := range []string{".", "..", "../.."} {
			p := filepath.Join(c, up)
			if _, err := os.Stat(filepath.Join(p, "public")); err == nil {
				abs, _ := filepath.Abs(p)
				return abs
			}
		}
	}
	return "."
}

func padLeft(s string, n int) string {
	for len(s) < n {
		s = "0" + s
	}
	return s
}

func serveFile(path string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, path)
	})
}

var mimes = map[string]string{
	".m3u8": "application/vnd.apple.mpegurl",
	".mpd":  "application/dash+xml",
	".ts":   "video/mp2t",
	".m4s":  "video/iso.segment",
	".mp4":  "video/mp4",
	".key":  "application/octet-stream",
}

func withMime(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m, ok := mimes[strings.ToLower(filepath.Ext(r.URL.Path))]; ok {
			w.Header().Set("Content-Type", m)
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		next.ServeHTTP(w, r)
	})
}

func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func gate(next http.Handler) http.Handler {
	return withMime(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("magpie_session")
		if err != nil || c.Value != "let-me-in" {
			http.Error(w, "403: missing session cookie", http.StatusForbidden)
			return
		}
		ref := r.Header.Get("Referer")
		if !strings.HasPrefix(ref, "http://"+r.Host+"/") {
			http.Error(w, "403: bad referer "+ref, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		if os.Getenv("MAGPIE_QUIET") == "" {
			log.Printf("%d %s %s ref=%q", rec.status, r.Method, r.URL.Path, r.Header.Get("Referer"))
		}
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// throttle caps each response at bytesPerSec by sleeping between small writes.
func throttle(next http.Handler, bytesPerSec int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(&slowWriter{ResponseWriter: w, rate: bytesPerSec}, r)
	})
}

type slowWriter struct {
	http.ResponseWriter
	rate int
}

func (s *slowWriter) Write(p []byte) (int, error) {
	const chunk = 16 << 10
	written := 0
	for len(p) > 0 {
		n := len(p)
		if n > chunk {
			n = chunk
		}
		m, err := s.ResponseWriter.Write(p[:n])
		written += m
		if err != nil {
			return written, err
		}
		if f, ok := s.ResponseWriter.(http.Flusher); ok {
			f.Flush()
		}
		time.Sleep(time.Duration(n) * time.Second / time.Duration(s.rate))
		p = p[n:]
	}
	return written, nil
}

// liveSim replays a VOD rendition in dir as a live stream at
// <prefix><session>/{master.m3u8,index.m3u8,init and segment files}. Each
// session id gets its own clock from its first playlist request. Two segments
// are out at the start and one more each target duration; the window keeps the
// newest four, and EXT-X-ENDLIST follows the last segment, about 12 s in.
//
// With ads, a directory holding the ad clip as TS (ad000.ts) and as fMP4
// (ad-init.mp4, ad000.m4s), the playlist is stitched the way Twitch stitches
// ads into a viewer's: the fMP4 ad as a preroll, the first two live segments,
// the TS ad in place of the third, then the rest, six entries in all, so
// EXT-X-ENDLIST comes about 16 s in. Each ad sits behind EXT-X-DISCONTINUITY
// tags on a clock of its own (the ad clip is stamped 60 s in) and is titled
// after its source, where the live segments are titled "live", under
// EXT-X-TWITCH tags. The fMP4 ad lists its init with EXT-X-MAP, which by the
// HLS spec stays in force for the TS segments after it.
type liveSim struct {
	prefix string
	dir    string
	ads    string
	mu     sync.Mutex
	starts map[string]time.Time
}

// liveEntry is one segment of the replayed playlist: its EXTINF line and file
// name, whether a discontinuity precedes it, and the init it lists, if any.
type liveEntry struct {
	inf, name string
	disc      bool
	mapName   string
}

func (l *liveSim) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, l.prefix), "/")
	if len(parts) != 2 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	session, file := parts[0], parts[1]
	switch file {
	case "master.m3u8":
		fmt.Fprint(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1280x720\nindex.m3u8\n")
	case "index.m3u8":
		l.playlist(w, session)
	default:
		dir := l.dir
		if l.ads != "" && strings.HasPrefix(file, "ad") {
			dir = l.ads
		}
		http.ServeFile(w, r, filepath.Join(dir, filepath.Base(file)))
	}
}

// program is the whole playlist as entries, with the target duration and the
// header lines after EXTM3U (the version, and the init of an fMP4 rendition).
func (l *liveSim) program() ([]liveEntry, int, string, error) {
	data, err := os.ReadFile(filepath.Join(l.dir, "index.m3u8"))
	if err != nil {
		return nil, 0, "", err
	}
	target := 4
	var entries []liveEntry
	var inf string
	head := "#EXT-X-VERSION:3\n"
	for _, line := range strings.Split(strings.ReplaceAll(string(data), "\r", ""), "\n") {
		switch {
		case strings.HasPrefix(line, "#EXT-X-MAP:"):
			head = "#EXT-X-VERSION:7\n" + line + "\n"
		case strings.HasPrefix(line, "#EXT-X-TARGETDURATION:"):
			fmt.Sscanf(line, "#EXT-X-TARGETDURATION:%d", &target)
		case strings.HasPrefix(line, "#EXTINF:"):
			inf = line
		case line != "" && !strings.HasPrefix(line, "#"):
			entries = append(entries, liveEntry{inf: inf, name: line})
		}
	}
	if l.ads == "" {
		return entries, target, head, nil
	}
	if len(entries) < 5 {
		return nil, 0, "", fmt.Errorf("the ads replay needs five live segments, %s has %d", l.dir, len(entries))
	}
	live := func(e liveEntry, disc bool) liveEntry {
		return liveEntry{inf: e.inf + "live", name: e.name, disc: disc}
	}
	ad := func(name, source, mapName string) liveEntry {
		return liveEntry{inf: "#EXTINF:4.000000,Amazon|" + source, name: name, disc: true, mapName: mapName}
	}
	stitched := []liveEntry{
		ad("ad000.m4s", "preroll", "ad-init.mp4"),
		live(entries[0], true),
		live(entries[1], false),
		ad("ad000.ts", "midroll", ""),
		live(entries[3], true),
		live(entries[4], false),
	}
	return stitched, target, "#EXT-X-VERSION:6\n", nil
}

func (l *liveSim) playlist(w http.ResponseWriter, session string) {
	entries, target, head, err := l.program()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	l.mu.Lock()
	start, ok := l.starts[session]
	if !ok {
		start = time.Now()
		l.starts[session] = start
	}
	l.mu.Unlock()

	n := 2 + int(time.Since(start)/(time.Duration(target)*time.Second))
	if n > len(entries) {
		n = len(entries)
	}
	from := n - 4
	if from < 0 {
		from = 0
	}
	var b strings.Builder
	fmt.Fprintf(&b, "#EXTM3U\n%s#EXT-X-TARGETDURATION:%d\n#EXT-X-MEDIA-SEQUENCE:%d\n", head, target, from)
	if l.ads != "" {
		// What Twitch writes above the segments: the discontinuities gone from the window, and its own tags.
		discs := 0
		for _, e := range entries[:from] {
			if e.disc {
				discs++
			}
		}
		fmt.Fprintf(&b, "#EXT-X-DISCONTINUITY-SEQUENCE:%d\n#EXT-X-TWITCH-ELAPSED-SECS:%d.000\n#EXT-X-TWITCH-TOTAL-SECS:%d.000\n", discs, 13065+from*target, 13071+from*target)
	}
	for _, e := range entries[from:n] {
		if e.disc {
			b.WriteString("#EXT-X-DISCONTINUITY\n")
		}
		if e.mapName != "" {
			fmt.Fprintf(&b, "#EXT-X-MAP:URI=\"%s\"\n", e.mapName)
		}
		fmt.Fprintf(&b, "%s\n%s\n", e.inf, e.name)
	}
	if n == len(entries) {
		b.WriteString("#EXT-X-ENDLIST\n")
	}
	fmt.Fprint(w, b.String())
}

// xsDateTime formats t as an xs:dateTime in UTC with milliseconds. The live
// MPD attributes and /time both use it, so a player that syncs to /time and
// the server's availability rule agree to the millisecond.
func xsDateTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// dashLiveSim replays the static dash fixture in dir as a live DASH stream at
// <prefix><session>/{manifest.mpd,init and chunk files}. Each session id gets
// its own clock from its first request, and that instant becomes the MPD's
// availabilityStartTime. Segment n (1 based, the $Number$ in the chunk name)
// is published n segment durations after the start, once it is complete, the
// way a packager publishes; until then it answers 404. Init segments are
// always there. One segment duration after the last segment is out (24 s in)
// the MPD turns static with the full duration, and segments stay available.
//
// With timeline set, dir holds a SegmentTimeline fixture with $Time$ names
// instead, served by serveTimeline.
type dashLiveSim struct {
	prefix   string
	dir      string
	timeline bool
	mu       sync.Mutex
	starts   map[string]time.Time
}

var (
	dashChunk    = regexp.MustCompile(`^chunk-[^-]+-(\d+)\.m4s$`)
	dashTemplate = regexp.MustCompile(`<SegmentTemplate timescale="(\d+)" duration="(\d+)"`)
	dashDuration = regexp.MustCompile(`mediaPresentationDuration="PT([0-9.]+)S"`)
	dashPeriod   = regexp.MustCompile(`(<Period\b[^>]*\bstart=")[^"]*(")`)
)

func (d *dashLiveSim) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, d.prefix), "/")
	if len(parts) != 2 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	session, file := parts[0], filepath.Base(parts[1])

	d.mu.Lock()
	start, ok := d.starts[session]
	if !ok {
		start = time.Now().Truncate(time.Millisecond)
		d.starts[session] = start
	}
	d.mu.Unlock()

	data, err := os.ReadFile(filepath.Join(d.dir, "manifest.mpd"))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	mpd := strings.ReplaceAll(string(data), "\r", "")
	if d.timeline {
		d.serveTimeline(w, r, mpd, file, start)
		return
	}
	tmpl := dashTemplate.FindStringSubmatch(mpd)
	if tmpl == nil || !dashDuration.MatchString(mpd) || !dashPeriod.MatchString(mpd) ||
		!strings.Contains(mpd, `type="static"`) || !strings.Contains(mpd, "</MPD>") {
		http.Error(w, "the dash fixture MPD does not have the ffmpeg shape dashLiveSim rewrites", 500)
		return
	}
	scale, _ := strconv.ParseInt(tmpl[1], 10, 64)
	dur, _ := strconv.ParseInt(tmpl[2], 10, 64)
	if scale <= 0 || dur <= 0 {
		http.Error(w, "the dash fixture MPD has no segment duration", 500)
		return
	}
	seg := time.Duration(dur) * time.Second / time.Duration(scale)
	// The video chunks on disk set the segment count. The audio set has a
	// sixth 0.021 s chunk the MPD never lists; it stays unpublished.
	chunks, _ := filepath.Glob(filepath.Join(d.dir, "chunk-0-*.m4s"))
	count := len(chunks)

	switch {
	case file == "manifest.mpd":
		ended := time.Since(start) >= time.Duration(count+1)*seg
		fmt.Fprint(w, dashLive(mpd, start, ended, r.Host))
	case strings.HasPrefix(file, "init-") && strings.HasSuffix(file, ".m4s"):
		http.ServeFile(w, r, filepath.Join(d.dir, file))
	default:
		m := dashChunk.FindStringSubmatch(file)
		if m == nil {
			http.NotFound(w, r)
			return
		}
		n, _ := strconv.Atoi(m[1])
		if n < 1 || n > count || time.Since(start) < time.Duration(n)*seg {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(d.dir, file))
	}
}

// dashLive rewrites the fixture MPD for a session that started at start:
// dynamic with a 2 s update period while live, static with the fixture's
// duration once ended. Both forms carry the session's availabilityStartTime
// and a UTCTiming element naming this server's /time.
func dashLive(mpd string, start time.Time, ended bool, host string) string {
	// The ffmpeg MPD puts one root attribute per line, so the new attributes
	// take the place of mediaPresentationDuration in the same layout.
	attrs := []string{
		fmt.Sprintf("availabilityStartTime=%q", xsDateTime(start)),
		fmt.Sprintf("publishTime=%q", xsDateTime(time.Now())),
	}
	if ended {
		total, _ := strconv.ParseFloat(dashDuration.FindStringSubmatch(mpd)[1], 64)
		attrs = append(attrs, fmt.Sprintf("mediaPresentationDuration=\"PT%sS\"", strconv.FormatFloat(total, 'f', -1, 64)))
	} else {
		mpd = strings.Replace(mpd, `type="static"`, `type="dynamic"`, 1)
		attrs = append(attrs, `minimumUpdatePeriod="PT2S"`, `timeShiftBufferDepth="PT20S"`, `suggestedPresentationDelay="PT4S"`)
	}
	mpd = dashDuration.ReplaceAllLiteralString(mpd, strings.Join(attrs, "\n\t"))
	mpd = dashPeriod.ReplaceAllString(mpd, "${1}PT0S${2}")
	utc := fmt.Sprintf("\t<UTCTiming schemeIdUri=\"urn:mpeg:dash:utc:http-xsdate:2014\" value=\"http://%s/time\"/>\n</MPD>", host)
	return strings.Replace(mpd, "</MPD>", utc, 1)
}

// timelineWindow is how many of the newest segments a timeline session's MPD
// lists. Four 4 s segments: the first leaves the window when the fifth is
// published, so a recorder that keys on segment numbers, which restart at
// startNumber in every MPD, sees no new number from then on.
const timelineWindow = 4

var (
	dashRep       = regexp.MustCompile(`(?s)<Representation id="([^"]+)".*?</Representation>`)
	dashTimescale = regexp.MustCompile(`<SegmentTemplate timescale="(\d+)"`)
	dashTimeline  = regexp.MustCompile(`(?s)<SegmentTimeline>.*?</SegmentTimeline>`)
	dashS         = regexp.MustCompile(`<S\b([^>]*)/>`)
	dashSAttr     = regexp.MustCompile(`(\w+)="(-?\d+)"`)
	dashTimeChunk = regexp.MustCompile(`^chunk-([^-]+)-(\d+)\.m4s$`)
)

// timelineSeg is one segment of a representation's SegmentTimeline, in its timescale.
type timelineSeg struct {
	t, d int64
}

// timelineRep is one representation of the timeline fixture.
type timelineRep struct {
	timescale int64
	segs      []timelineSeg
}

// end is when segment i is complete, as an offset from availabilityStartTime.
func (r timelineRep) end(i int) time.Duration {
	s := r.segs[i]
	return time.Duration(s.t+s.d) * time.Second / time.Duration(r.timescale)
}

// published is how many of the representation's segments are out at elapsed:
// a segment is published once it is complete, as a packager publishes.
func (r timelineRep) published(elapsed time.Duration) int {
	n := 0
	for n < len(r.segs) && r.end(n) <= elapsed {
		n++
	}
	return n
}

// parseTimeline reads each representation's timescale and expanded S entries
// from the fixture MPD.
func parseTimeline(mpd string) (map[string]timelineRep, error) {
	reps := map[string]timelineRep{}
	for _, m := range dashRep.FindAllStringSubmatch(mpd, -1) {
		ts := dashTimescale.FindStringSubmatch(m[0])
		block := dashTimeline.FindString(m[0])
		if ts == nil || block == "" {
			return nil, fmt.Errorf("representation %s has no SegmentTemplate timescale or SegmentTimeline", m[1])
		}
		rep := timelineRep{}
		rep.timescale, _ = strconv.ParseInt(ts[1], 10, 64)
		var t int64
		for _, s := range dashS.FindAllStringSubmatch(block, -1) {
			attrs := map[string]int64{}
			for _, a := range dashSAttr.FindAllStringSubmatch(s[1], -1) {
				attrs[a[1]], _ = strconv.ParseInt(a[2], 10, 64)
			}
			if v, ok := attrs["t"]; ok {
				t = v
			}
			for k := int64(0); k <= attrs["r"]; k++ {
				rep.segs = append(rep.segs, timelineSeg{t: t, d: attrs["d"]})
				t += attrs["d"]
			}
		}
		if rep.timescale <= 0 || len(rep.segs) == 0 {
			return nil, fmt.Errorf("representation %s has an empty timeline", m[1])
		}
		reps[m[1]] = rep
	}
	if len(reps) == 0 {
		return nil, fmt.Errorf("the fixture MPD has no representations")
	}
	return reps, nil
}

// serveTimeline replays the dash-timeline fixture as a live stream whose
// SegmentTimeline slides: each MPD lists the newest timelineWindow published
// segments of every representation as explicit S entries and never changes
// startNumber, the way $Time$ packagers do. availabilityStartTime is one
// segment before the session started, so the first MPD already lists a
// segment. A chunk answers 404 until it is published. Once every segment is
// out and one more segment duration has passed, the MPD turns static and
// keeps listing the same window, so only a recorder that followed the window
// has the newest segment.
func (d *dashLiveSim) serveTimeline(w http.ResponseWriter, r *http.Request, mpd, file string, start time.Time) {
	reps, err := parseTimeline(mpd)
	if err != nil || !dashDuration.MatchString(mpd) || !dashPeriod.MatchString(mpd) ||
		!strings.Contains(mpd, `type="static"`) || !strings.Contains(mpd, "</MPD>") {
		http.Error(w, fmt.Sprintf("the dash-timeline fixture MPD does not have the ffmpeg shape serveTimeline rewrites (%v)", err), 500)
		return
	}
	// The video sets the segment duration and the count; the audio has the same count.
	ref, ok := reps["0"]
	if !ok {
		http.Error(w, "the dash-timeline fixture MPD has no representation 0", 500)
		return
	}
	seg := time.Duration(ref.segs[0].d) * time.Second / time.Duration(ref.timescale)
	ast := start.Add(-seg)
	elapsed := time.Since(ast)

	switch {
	case file == "manifest.mpd":
		ended := elapsed >= time.Duration(len(ref.segs)+1)*seg
		out := dashRep.ReplaceAllStringFunc(mpd, func(block string) string {
			id := dashRep.FindStringSubmatch(block)[1]
			rep := reps[id]
			n := rep.published(elapsed)
			from := n - timelineWindow
			if from < 0 {
				from = 0
			}
			var b strings.Builder
			b.WriteString("<SegmentTimeline>\n")
			for i := from; i < n; i++ {
				fmt.Fprintf(&b, "\t\t\t\t\t\t<S t=\"%d\" d=\"%d\" />\n", rep.segs[i].t, rep.segs[i].d)
			}
			b.WriteString("\t\t\t\t\t</SegmentTimeline>")
			return dashTimeline.ReplaceAllLiteralString(block, b.String())
		})
		fmt.Fprint(w, dashLive(out, ast, ended, r.Host))
	case strings.HasPrefix(file, "init-") && strings.HasSuffix(file, ".m4s"):
		http.ServeFile(w, r, filepath.Join(d.dir, file))
	default:
		m := dashTimeChunk.FindStringSubmatch(file)
		if m == nil {
			http.NotFound(w, r)
			return
		}
		rep, ok := reps[m[1]]
		t, _ := strconv.ParseInt(m[2], 10, 64)
		if !ok {
			http.NotFound(w, r)
			return
		}
		for i, s := range rep.segs {
			if s.t == t && rep.end(i) <= elapsed {
				http.ServeFile(w, r, filepath.Join(d.dir, file))
				return
			}
		}
		http.NotFound(w, r)
	}
}
