// SPDX-License-Identifier: AGPL-3.0-or-later
// YITOKEN Studio download relay. Upstream client: Moyin Creator / MemeCalculate.
package main

import (
	"context"
	"crypto/sha256"
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
	"os"
	"strconv"
	"strings"
	"time"
)

const upstreamPrefix = "/ZonEaseTech/yitoken-studio/releases/download/v0.1.0-alpha.2/"

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
	client      *http.Client
	assets      map[string]asset
	slots       chan struct{}
	mirrorRoot  *os.Root
	mirrorFiles map[string]os.FileInfo
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
		if len(assets) != 13 {
			panic("incomplete embedded manifest")
		}
		for _, name := range []string{
			"BUILD-PROVENANCE-linux-x64.json",
			"BUILD-PROVENANCE-mac-arm64.json",
			"BUILD-PROVENANCE-mac-x64.json",
			"BUILD-PROVENANCE-win-x64.json",
			"SHA256SUMS.txt",
			"YITOKEN.Studio-0.1.0-alpha.2.AppImage",
			"yitoken-studio-0.1.0-alpha.2-arm64-mac.dmg",
			"yitoken-studio-0.1.0-alpha.2-arm64-mac.zip",
			"yitoken-studio-0.1.0-alpha.2-setup.exe",
			"yitoken-studio-0.1.0-alpha.2-source.tar.gz",
			"yitoken-studio-0.1.0-alpha.2-source.tar.gz.sha256",
			"yitoken-studio-0.1.0-alpha.2-x64-mac.dmg",
			"yitoken-studio-0.1.0-alpha.2-x64-mac.zip",
		} {
			if _, exists := assets[name]; !exists {
				panic("unexpected embedded release asset set")
			}
		}
	}
	return &relay{client: client, assets: assets, slots: make(chan struct{}, 8)}
}

// loadMirror hashes only allowlisted files; no directory listing or download is performed.
// The operator must mount the verified directory read-only for the process lifetime.
func (h *relay) loadMirror(dir string) error {
	if h.mirrorRoot != nil {
		return errors.New("mirror already configured")
	}
	directory, err := os.Lstat(dir)
	if err != nil || !directory.IsDir() || directory.Mode()&os.ModeSymlink != 0 {
		return errors.New("invalid mirror directory")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return errors.New("mirror directory unavailable")
	}
	verified := make(map[string]os.FileInfo)
	defer func() {
		if h.mirrorRoot != root {
			_ = root.Close()
		}
	}()
	for name, a := range h.assets {
		if !validFilename(name) || a.Name != name {
			return errors.New("invalid mirror asset name")
		}
		info, err := root.Lstat(name)
		if errors.Is(err, os.ErrNotExist) {
			continue // A genuinely absent asset keeps the existing fixed GitHub route.
		}
		if err != nil || !info.Mode().IsRegular() || info.Size() != a.Size {
			return fmt.Errorf("invalid mirror asset: %s", name)
		}
		file, err := root.Open(name)
		if err != nil {
			return fmt.Errorf("mirror asset unavailable: %s", name)
		}
		opened, statErr := file.Stat()
		if statErr != nil || !os.SameFile(info, opened) || !opened.Mode().IsRegular() || opened.Size() != a.Size {
			_ = file.Close()
			return fmt.Errorf("mirror asset changed: %s", name)
		}
		hash := sha256.New()
		copied, hashErr := io.Copy(hash, file)
		after, afterErr := file.Stat()
		closeErr := file.Close()
		if hashErr != nil || afterErr != nil || closeErr != nil || copied != a.Size || after.Size() != a.Size || !opened.ModTime().Equal(after.ModTime()) || fmt.Sprintf("%x", hash.Sum(nil)) != a.SHA256 {
			return fmt.Errorf("mirror integrity check failed: %s", name)
		}
		verified[name] = after
	}
	if len(verified) == 0 {
		return errors.New("mirror contains no verified assets")
	}
	h.mirrorFiles, h.mirrorRoot = verified, root
	return nil
}

func (h *relay) closeMirror() error {
	if h.mirrorRoot == nil {
		return nil
	}
	err := h.mirrorRoot.Close()
	h.mirrorRoot, h.mirrorFiles = nil, nil
	return err
}

type mirrorBody struct {
	ctx context.Context
	*io.SectionReader
	file *os.File
}

func (b *mirrorBody) Read(p []byte) (int, error) {
	if err := b.ctx.Err(); err != nil {
		return 0, err
	}
	return b.SectionReader.Read(p)
}

func (b *mirrorBody) Close() error { return b.file.Close() }

func (h *relay) openMirror(ctx context.Context, r *http.Request, a asset, start, end int64) (*http.Response, error) {
	verified := h.mirrorFiles[a.Name]
	info, err := h.mirrorRoot.Lstat(a.Name)
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(verified, info) || info.Size() != a.Size || !verified.ModTime().Equal(info.ModTime()) {
		return nil, errors.New("mirror changed")
	}
	file, err := h.mirrorRoot.Open(a.Name)
	if err != nil {
		return nil, errors.New("mirror unavailable")
	}
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(verified, opened) || opened.Size() != a.Size || !verified.ModTime().Equal(opened.ModTime()) {
		_ = file.Close()
		return nil, errors.New("mirror changed")
	}
	etag := `"sha256-` + a.SHA256 + `"`
	header := http.Header{"Etag": {etag}}
	status := http.StatusOK
	if r.Header.Get("Range") != "" && (r.Header.Get("If-Range") == "" || r.Header.Get("If-Range") == etag) {
		status = http.StatusPartialContent
		header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, a.Size))
	} else {
		start, end = 0, a.Size-1
	}
	length := end - start + 1
	return &http.Response{
		StatusCode: status, Header: header, ContentLength: length,
		Body: &mirrorBody{ctx: ctx, SectionReader: io.NewSectionReader(file, start, length), file: file},
	}, nil
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
		w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
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
	// One exact legacy checklist alias, after method/query/encoded-path validation.
	if name == "SHA256SUMS-GITHUB.txt" {
		name = "SHA256SUMS.txt"
	}
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
	var response *http.Response
	if _, mirrored := h.mirrorFiles[name]; mirrored {
		response, err = h.openMirror(ctx, r, a, start, end)
		if err != nil {
			w.Header().Set("Retry-After", "5")
			writeError(w, r, 503, "download mirror unavailable")
			return
		}
	} else {
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
		response, err = h.client.Do(upstream)
		if err != nil {
			writeError(w, r, 502, "download unavailable")
			return
		}
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
	handler := newRelay(productionClient(), nil)
	if dir, configured := os.LookupEnv("YITOKEN_DOWNLOAD_MIRROR_DIR"); configured {
		if err := handler.loadMirror(dir); err != nil {
			log.Fatal("download mirror validation failed")
		}
		defer handler.closeMirror()
	}
	server := &http.Server{
		Addr: ":8080", Handler: handler,
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: transferTimeout + time.Minute, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024,
	}
	log.Print("download relay listening on :8080")
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal("download relay stopped")
	}
}
