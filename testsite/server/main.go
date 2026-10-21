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
