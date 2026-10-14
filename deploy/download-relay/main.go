// SPDX-License-Identifier: AGPL-3.0-or-later
// YITOKEN Studio download relay. Upstream client: Moyin Creator / MemeCalculate.
package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const upstreamPrefix = "/ZonEaseTech/yitoken-studio/releases/download/v0.1.0-alpha.1/"

// Large installers must remain resumable on slow international links; still bounded.
const transferTimeout = 2 * time.Hour

//go:embed index.html
var indexPage []byte

//go:embed manifest.json
var manifestDocument []byte

//go:embed version.json
var versionDocument []byte

//go:embed relay-source.tar.gz
var sourceArchive []byte

type asset struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type relay struct {
	client *http.Client
	assets map[string]asset
	slots  chan struct{}
}

func newRelay(client *http.Client, assets map[string]asset) *relay {
	if assets == nil {
		var document struct {
			Assets []asset `json:"assets"`
		}
		if err := json.Unmarshal(manifestDocument, &document); err != nil {
			panic("invalid embedded manifest")
		}
		assets = make(map[string]asset, len(document.Assets))
		for _, a := range document.Assets {
			if !validFilename(a.Name) || a.Size <= 0 || len(a.SHA256) != 64 {
				panic("invalid embedded asset")
			}
			if _, exists := assets[a.Name]; exists {
				panic("duplicate embedded asset")
			}
			if _, err := strconv.ParseUint(a.SHA256[:16], 16, 64); err != nil {
				panic("invalid embedded hash")
			}
			for _, c := range a.SHA256 {
				if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
					panic("invalid embedded hash")
				}
			}
			assets[a.Name] = a
		}
		if len(assets) != 15 {
			panic("incomplete embedded manifest")
		}
	}
	return &relay{client: client, assets: assets, slots: make(chan struct{}, 8)}
}

func validFilename(name string) bool {
	if name == "" || name == "." || name == ".." {
		return false
	}
	for _, c := range name {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (h *relay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeError(w, r, 405, "method not allowed")
		return
	}
	// Never clean or decode a user-selected path into a different allowlisted file.
	queryAllowed := r.URL.RawQuery == ""
	if timestamp, ok := strings.CutPrefix(r.URL.RawQuery, "_ts="); r.URL.Path == "/downloads/version.json" && ok && len(timestamp) > 0 && len(timestamp) <= 16 {
		// The frozen client adds a decimal cache-buster. This local-only exception
		// never selects an upstream or applies to installation-file requests.
		queryAllowed = !strings.ContainsFunc(timestamp, func(c rune) bool { return c < '0' || c > '9' })
	}
	if !queryAllowed || r.URL.ForceQuery || r.URL.RawPath != "" || strings.Contains(r.URL.EscapedPath(), "%") {
		writeError(w, r, 400, "invalid download request")
		return
	}
	switch r.URL.Path {
	case "/healthz":
		writeLocal(w, r, []byte("ok\n"), "text/plain; charset=utf-8", "")
		return
	case "/downloads/":
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		writeLocal(w, r, indexPage, "text/html; charset=utf-8", "")
		return
	case "/downloads/manifest.json":
		writeLocal(w, r, manifestDocument, "application/json", "")
		return
	case "/downloads/version.json":
		writeLocal(w, r, versionDocument, "application/json", "")
		return
	case "/downloads/relay-source.tar.gz":
		writeLocal(w, r, sourceArchive, "application/octet-stream", "relay-source.tar.gz")
		return
	}
	name, ok := strings.CutPrefix(r.URL.Path, "/downloads/assets/")
	a, known := h.assets[name]
	if !ok || !known || !validFilename(name) {
		writeError(w, r, 404, "download not found")
		return
	}
	if len(r.Header.Values("Range")) > 1 || len(r.Header.Values("If-Range")) > 1 {
		writeError(w, r, 400, "invalid download request")
		return
	}
	start, end, err := parseRange(r.Header.Get("Range"), a.Size)
	if err != nil {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", a.Size))
		writeError(w, r, 416, "range not satisfiable")
		return
	}
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		w.Header().Set("Retry-After", "5")
		writeError(w, r, 503, "downloads busy; retry later")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), transferTimeout)
	defer cancel()
	upstream, err := http.NewRequestWithContext(ctx, r.Method, "https://github.com"+upstreamPrefix+name, nil)
	if err != nil {
		writeError(w, r, 502, "download unavailable")
		return
	}
	upstream.Header.Set("User-Agent", "YITOKEN-Studio-Download-Relay/1")
	upstream.Header.Set("Accept-Encoding", "identity")
	if r.Header.Get("Range") != "" {
		upstream.Header.Set("Range", r.Header.Get("Range"))
		if value := r.Header.Get("If-Range"); value != "" {
			upstream.Header.Set("If-Range", value)
		}
	}
	response, err := h.client.Do(upstream)
	if err != nil {
		writeError(w, r, 502, "download unavailable")
		return
	}
	defer response.Body.Close()
	expected := a.Size
	contentRange := ""
	switch response.StatusCode {
	case http.StatusOK:
		if response.Header.Get("Content-Range") != "" {
			writeError(w, r, 502, "download unavailable")
			return
		}
	case http.StatusPartialContent:
		if r.Header.Get("Range") == "" {
			writeError(w, r, 502, "download unavailable")
			return
		}
		contentRange = fmt.Sprintf("bytes %d-%d/%d", start, end, a.Size)
		if response.Header.Get("Content-Range") != contentRange {
			writeError(w, r, 502, "download unavailable")
			return
		}
		expected = end - start + 1
	default:
		writeError(w, r, 502, "download unavailable")
		return
	}
	if response.ContentLength != expected || response.Uncompressed || response.Header.Get("Content-Encoding") != "" && response.Header.Get("Content-Encoding") != "identity" {
		writeError(w, r, 502, "download unavailable")
		return
	}
	// Only sanitized local headers: no Location, cookies or signed upstream URLs.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Encoding", "identity")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	w.Header().Set("Content-Length", strconv.FormatInt(expected, 10))
	w.Header().Set("Accept-Ranges", "bytes")
	for _, key := range []string{"ETag", "Last-Modified"} {
		if value := response.Header.Get(key); value != "" {
			w.Header().Set(key, value)
		}
	}
	if contentRange != "" {
		w.Header().Set("Content-Range", contentRange)
	}
	w.WriteHeader(response.StatusCode)
	if r.Method == http.MethodHead {
		return
	}
	if _, err := io.CopyN(w, response.Body, expected); err != nil {
		// Headers are committed: close/reset the stream, never append an error page
		// or report successful EOF. Do not log errors containing signed asset URLs.
		panic(http.ErrAbortHandler)
	}
}

func writeLocal(w http.ResponseWriter, r *http.Request, data []byte, contentType, filename string) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	if filename != "" {
		w.Header().Set("Content-Encoding", "identity")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	}
	w.WriteHeader(200)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}
func writeError(w http.ResponseWriter, r *http.Request, status int, message string) {
	data := []byte(message + "\n")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}

// Exactly one byte range, bounded by trusted immutable release metadata.
func parseRange(value string, size int64) (int64, int64, error) {
	if value == "" {
		return 0, size - 1, nil
	}
	bad := errors.New("invalid range")
	part, ok := strings.CutPrefix(value, "bytes=")
	if !ok || strings.ContainsAny(part, ", \t\r\n") {
		return 0, 0, bad
	}
	first, last, ok := strings.Cut(part, "-")
	if !ok || strings.Contains(last, "-") {
		return 0, 0, bad
	}
	digits := func(s string) (int64, error) {
		if s == "" {
			return 0, bad
		}
		for _, c := range s {
			if c < '0' || c > '9' {
				return 0, bad
			}
		}
		return strconv.ParseInt(s, 10, 64)
	}
	if first == "" {
		suffix, err := digits(last)
		if err != nil || suffix <= 0 {
			return 0, 0, bad
		}
		return max(0, size-suffix), size - 1, nil
	}
	start, err := digits(first)
	if err != nil || start >= size {
		return 0, 0, bad
	}
	if last == "" {
		return start, size - 1, nil
	}
	end, err := digits(last)
	if err != nil || end < start {
		return 0, 0, bad
	}
	return start, min(end, size-1), nil
}

func allowedRedirect(u *url.URL, name string) bool {
	if u.Scheme != "https" || u.User != nil || u.Opaque != "" || u.Fragment != "" || u.Port() != "" && u.Port() != "443" {
		return false
	}
	switch u.Hostname() {
	case "github.com":
		return u.Path == upstreamPrefix+name && u.RawPath == "" && u.RawQuery == "" && !u.ForceQuery
	case "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return true
	default:
		return false
	}
}
func productionClient() *http.Client {
	transport := &http.Transport{
		Proxy:             nil,
		DialContext:       (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2: true, DisableCompression: true,
		TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 30 * time.Second,
		IdleConnTimeout: 90 * time.Second, MaxIdleConns: 16, MaxIdleConnsPerHost: 8, MaxConnsPerHost: 8,
	}
	return &http.Client{Transport: transport, Timeout: transferTimeout, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) == 0 || len(via) > 5 {
			return errors.New("redirect rejected")
		}
		name := strings.TrimPrefix(via[0].URL.Path, upstreamPrefix)
		if !validFilename(name) || !allowedRedirect(r.URL, name) {
			return errors.New("redirect rejected")
		}
		// net/http may copy headers to redirects; keep only these download headers.
		headers := http.Header{}
		for _, key := range []string{"Range", "If-Range", "User-Agent", "Accept-Encoding"} {
			if value := via[0].Header.Get(key); value != "" {
				headers.Set(key, value)
			}
		}
		r.Header = headers
		return nil
	}}
}

func main() {
	server := &http.Server{
		Addr: ":8080", Handler: newRelay(productionClient(), nil),
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: transferTimeout + time.Minute, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024,
	}
	log.Print("download relay listening on :8080")
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal("download relay stopped")
	}
}
