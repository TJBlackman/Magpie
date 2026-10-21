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

	// Live: the hls-ts clip, and an fMP4 rendition whose timestamps start hours
	// in, replayed as live streams, see liveSim.
	mux.Handle("/live/", noCache(withMime(&liveSim{prefix: "/live/", dir: filepath.Join(media, "hls-ts"), starts: map[string]time.Time{}})))
	mux.Handle("/live-fmp4/", noCache(withMime(&liveSim{prefix: "/live-fmp4/", dir: filepath.Join(media, "hls-live-fmp4"), starts: map[string]time.Time{}})))

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
type liveSim struct {
	prefix string
	dir    string
	mu     sync.Mutex
	starts map[string]time.Time
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
		http.ServeFile(w, r, filepath.Join(l.dir, filepath.Base(file)))
	}
}

func (l *liveSim) playlist(w http.ResponseWriter, session string) {
	data, err := os.ReadFile(filepath.Join(l.dir, "index.m3u8"))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	target := 4
	var infs, names []string
	head := "#EXT-X-VERSION:3\n"
	for _, line := range strings.Split(strings.ReplaceAll(string(data), "\r", ""), "\n") {
		switch {
		case strings.HasPrefix(line, "#EXT-X-MAP:"):
			head = "#EXT-X-VERSION:7\n" + line + "\n"
		case strings.HasPrefix(line, "#EXT-X-TARGETDURATION:"):
			fmt.Sscanf(line, "#EXT-X-TARGETDURATION:%d", &target)
		case strings.HasPrefix(line, "#EXTINF:"):
			infs = append(infs, line)
		case line != "" && !strings.HasPrefix(line, "#"):
			names = append(names, line)
		}
	}

	l.mu.Lock()
	start, ok := l.starts[session]
	if !ok {
		start = time.Now()
		l.starts[session] = start
	}
	l.mu.Unlock()

	n := 2 + int(time.Since(start)/(time.Duration(target)*time.Second))
	if n > len(names) {
		n = len(names)
	}
	from := n - 4
	if from < 0 {
		from = 0
	}
	var b strings.Builder
	fmt.Fprintf(&b, "#EXTM3U\n%s#EXT-X-TARGETDURATION:%d\n#EXT-X-MEDIA-SEQUENCE:%d\n", head, target, from)
	for i := from; i < n; i++ {
		fmt.Fprintf(&b, "%s\n%s\n", infs[i], names[i])
	}
	if n == len(names) {
		b.WriteString("#EXT-X-ENDLIST\n")
	}
	fmt.Fprint(w, b.String())
}
