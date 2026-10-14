package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func fixture(t *testing.T, serve http.HandlerFunc) *relay {
	t.Helper()
	s := httptest.NewServer(serve)
	t.Cleanup(s.Close)
	transport := transportFunc(func(r *http.Request) (*http.Response, error) {
		c := r.Clone(r.Context())
		u, _ := url.Parse(s.URL)
		c.URL = u
		c.URL.Path = r.URL.Path
		return http.DefaultTransport.RoundTrip(c)
	})
	return newRelay(&http.Client{Transport: transport}, map[string]asset{"sample.zip": {Name: "sample.zip", Size: 6, SHA256: strings.Repeat("a", 64)}})
}
func TestRelayStreamsLocalAssetWithoutSensitiveHeaders(t *testing.T) {
	h := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != upstreamPrefix+"sample.zip" {
			t.Errorf("path %s", r.URL.Path)
		}
		for _, k := range []string{"Cookie", "Authorization", "X-API-Key", "Referer", "Origin"} {
			if r.Header.Get(k) != "" {
				t.Errorf("forwarded %s", k)
			}
		}
		if r.Header.Get("Accept-Encoding") != "identity" {
			t.Error("not identity")
		}
		w.Header().Set("Content-Length", "6")
		w.Header().Set("Location", "https://signed.secret.invalid/")
		w.Header().Set("Set-Cookie", "secret=1")
		io.WriteString(w, "abcdef")
	})
	for _, method := range []string{"GET", "HEAD"} {
		t.Run(method, func(t *testing.T) {
			r := httptest.NewRequest(method, "/downloads/assets/sample.zip", nil)
			r.Header.Set("Cookie", "secret=1")
			r.Header.Set("Authorization", "Bearer secret")
			r.Header.Set("X-API-Key", "secret")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != 200 {
				t.Fatalf("want 200, got %d", w.Code)
			}
			if w.Header().Get("Location") != "" || w.Header().Get("Set-Cookie") != "" {
				t.Error("secret response headers leaked")
			}
			if w.Header().Get("Content-Length") != "6" || w.Header().Get("Accept-Ranges") != "bytes" || w.Header().Get("Cache-Control") != "no-store, no-transform" {
				t.Errorf("headers %v", w.Header())
			}
			if method == "GET" && w.Body.String() != "abcdef" {
				t.Errorf("body %q", w.Body.String())
			}
			if method == "HEAD" && w.Body.Len() != 0 {
				t.Error("HEAD body")
			}
		})
	}
}
func TestRejectedPathsAndMethodsNeverReachUpstream(t *testing.T) {
	var calls atomic.Int32
	h := fixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); t.Error("unexpected upstream") })
	for _, path := range []string{"/downloads/assets/other.zip", "/downloads/assets/%73ample.zip", "/downloads/assets/sample.zip?url=https://evil.invalid", "/downloads/assets/%2e%2e%2fsecret", "/downloads/assets/a%2fsample.zip", "/downloads/assets/../sample.zip", "/downloads/assets/sample.zip/", "/elsewhere"} {
		r := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code < 400 {
			t.Errorf("accepted %s", path)
		}
	}
	r := httptest.NewRequest("POST", "/downloads/assets/sample.zip", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 405 || w.Header().Get("Allow") != "GET, HEAD" {
		t.Errorf("method %d", w.Code)
	}
	if calls.Load() != 0 {
		t.Error("upstream called")
	}
}
func TestRangeValidationAndUpstreamResponse(t *testing.T) {
	cases := []struct {
		rangeValue, ifRange        string
		status                     int
		length, contentRange, body string
		want                       int
	}{
		{"bytes=1-3", "", 206, "3", "bytes 1-3/6", "bcd", 206},
		{"bytes=3-", "", 206, "3", "bytes 3-5/6", "def", 206},
		{"bytes=-2", "", 206, "2", "bytes 4-5/6", "ef", 206},
		{"bytes=0-99", "", 206, "6", "bytes 0-5/6", "abcdef", 206},
		{"bytes=6-", "", 200, "6", "", "abcdef", 416},
		{"bytes=3-1", "", 200, "6", "", "abcdef", 416},
		{"bytes=0-0,2-3", "", 200, "6", "", "abcdef", 416},
		{"bytes=-0", "", 200, "6", "", "abcdef", 416},
		{"bytes=99999999999999999999999999-", "", 200, "6", "", "abcdef", 416},
		{"bytes=1-3", "", 206, "3", "bytes 2-4/6", "cde", 502},
		{"bytes=1-3", "", 206, "3", "bytes 1-3/7", "bcd", 502},
		{"bytes=1-3", "", 206, "6", "bytes 1-3/6", "abcdef", 502},
		{"", "", 206, "3", "bytes 1-3/6", "bcd", 502},
		{"", "", 200, "5", "", "abcde", 502},
		{"", "", 200, "6", "bytes 0-5/6", "abcdef", 502},
		{"", "", 403, "6", "", "abcdef", 502},
		{"bytes=1-3", "\"old\"", 200, "6", "", "abcdef", 200},
	}
	for _, tc := range cases {
		t.Run(tc.rangeValue+"_"+tc.contentRange+"_"+tc.length+"_"+tc.ifRange, func(t *testing.T) {
			var calls atomic.Int32
			h := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Header.Get("Range") != tc.rangeValue || r.Header.Get("If-Range") != tc.ifRange {
					t.Error("range changed")
				}
				w.Header().Set("Content-Length", tc.length)
				if tc.contentRange != "" {
					w.Header().Set("Content-Range", tc.contentRange)
				}
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			})
			r := httptest.NewRequest("GET", "/downloads/assets/sample.zip", nil)
			r.Header.Set("Range", tc.rangeValue)
			r.Header.Set("If-Range", tc.ifRange)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Errorf("want %d got %d body %q", tc.want, w.Code, w.Body.String())
			}
			if tc.want == 416 && (calls.Load() != 0 || w.Header().Get("Content-Range") != "bytes */6") {
				t.Error("416 not local or lacks total")
			}
			if tc.want == 502 && strings.Contains(w.Body.String(), tc.body) && tc.body != "" {
				t.Error("upstream body leaked")
			}
		})
	}
}
func TestRedirectAllowlist(t *testing.T) {
	for _, tc := range []struct {
		u  string
		ok bool
	}{
		{"https://github.com" + upstreamPrefix + "sample.zip", true}, {"https://release-assets.githubusercontent.com/path?sig=secret", true}, {"https://objects.githubusercontent.com/path", true},
		{"http://github.com" + upstreamPrefix + "sample.zip", false}, {"https://github.com/other/repo", false}, {"https://github.com" + upstreamPrefix + "other.zip", false}, {"https://github.com" + upstreamPrefix + "sample.zip?evil=1", false}, {"https://evil.invalid/", false}, {"https://release-assets.githubusercontent.com:444/x", false}, {"https://user@objects.githubusercontent.com/x", false}, {"https://objects.githubusercontent.com.evil.invalid/x", false},
	} {
		u, _ := url.Parse(tc.u)
		if allowedRedirect(u, "sample.zip") != tc.ok {
			t.Errorf("allowlist mismatch %s", tc.u)
		}
	}
	client := productionClient()
	r := httptest.NewRequest("GET", "https://release-assets.githubusercontent.com/x", nil)
	via := []*http.Request{httptest.NewRequest("GET", "https://github.com"+upstreamPrefix+"sample.zip", nil)}
	if client.CheckRedirect(r, via) != nil {
		t.Error("allowed redirect rejected")
	}
	for len(via) < 6 {
		via = append(via, via[0])
	}
	if client.CheckRedirect(r, via) == nil {
		t.Error("unbounded redirect")
	}
}
func TestConcurrencyLimitAndCancel(t *testing.T) {
	entered := make(chan struct{}, 8)
	done := make(chan struct{}, 8)
	h := newRelay(&http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		entered <- struct{}{}
		<-r.Context().Done()
		done <- struct{}{}
		return nil, r.Context().Err()
	})}, map[string]asset{"sample.zip": {Name: "sample.zip", Size: 6}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan struct{}, 8)
	for range 8 {
		go func() {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "/downloads/assets/sample.zip", nil).WithContext(ctx))
			finished <- struct{}{}
		}()
	}
	for range 8 {
		<-entered
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/downloads/assets/sample.zip", nil))
	if w.Code != 503 || w.Header().Get("Retry-After") == "" {
		t.Errorf("limit: %d", w.Code)
	}
	cancel()
	for range 8 {
		<-done
		<-finished
	}
	if len(h.slots) != 0 {
		t.Error("slots leaked")
	}
}
func TestLocalDocumentsAndPage(t *testing.T) {
	h := newRelay(productionClient(), nil)
	for _, path := range []string{"/downloads/", "/downloads/manifest.json", "/downloads/version.json", "/downloads/relay-source.tar.gz", "/healthz"} {
		for _, method := range []string{"GET", "HEAD"} {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(method, path, nil))
			if w.Code != 200 {
				t.Errorf("%s: %d", path, w.Code)
			}
			if method == "HEAD" && w.Body.Len() != 0 {
				t.Error("local HEAD body")
			}
		}
	}
	// The frozen Electron updater always adds this cache-buster to version.json.
	for _, method := range []string{"GET", "HEAD"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, "/downloads/version.json?_ts=1791974197000", nil))
		if w.Code != 200 || method == "GET" && !bytes.Equal(w.Body.Bytes(), versionDocument) || method == "HEAD" && w.Body.Len() != 0 {
			t.Errorf("updater cache-buster %s: status=%d body=%q", method, w.Code, w.Body.String())
		}
	}
	for _, path := range []string{
		"/downloads/version.json?url=https://evil.invalid", "/downloads/version.json?_ts=1&_ts=2",
		"/downloads/version.json?_ts=1&url=x", "/downloads/version.json?_ts=", "/downloads/version.json?_ts=-1",
		"/downloads/version.json?_ts=12345678901234567", "/downloads/version.json?_ts=%31",
		"/downloads/version.json?%5Fts=1", "/downloads/version.json?", "/downloads/?_ts=1",
		"/downloads/assets/SHA256SUMS-GITHUB.txt?_ts=1",
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 400 {
			t.Errorf("invalid cache-buster %s: status=%d", path, w.Code)
		}
	}
	b, _ := os.ReadFile("index.html")
	page := string(b)
	for _, want := range []string{"Windows x64", "Linux x64", "macOS Apple Silicon", "macOS Intel", "SHA256SUMS-GITHUB.txt", "/downloads/relay-source.tar.gz", "Moyin Creator", "/keys"} {
		if !strings.Contains(page, want) {
			t.Errorf("missing page %s", want)
		}
	}
	if strings.Contains(page, "@@") || strings.Contains(page, "https://fonts") || strings.Contains(page, "<script") {
		t.Error("page requires remote or unrendered content")
	}
}
func TestCorrespondingSourceArchiveMatchesCheckout(t *testing.T) {
	z, err := gzip.NewReader(bytes.NewReader(sourceArchive))
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	tr := tar.NewReader(z)
	seen := map[string]bool{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		name := strings.TrimPrefix(h.Name, "download-relay/")
		real, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(b, real) {
			t.Errorf("stale source archive %s", name)
		}
		seen[name] = true
	}
	for _, name := range []string{"main.go", "main_test.go", "go.mod", "index.html", "manifest.json", "version.json", "README.md", "Dockerfile", "LICENSE", "package-source.sh"} {
		if !seen[name] {
			t.Errorf("source missing %s", name)
		}
	}
}

func TestTruncatedUpstreamAbortsRatherThanSuccessfulResponse(t *testing.T) {
	h := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "6")
		io.WriteString(w, "abc")
	})
	server := httptest.NewServer(h)
	defer server.Close()
	response, err := server.Client().Get(server.URL + "/downloads/assets/sample.zip")
	if err != nil {
		return
	} // Abort may precede net/http's buffered header flush.
	defer response.Body.Close()
	_, err = io.ReadAll(response.Body)
	if err == nil {
		t.Fatal("truncated upstream incorrectly returned successful EOF")
	}
	if len(h.slots) != 0 {
		t.Error("slot leaked after abort")
	}
}
func TestRangeHEADAndValidators(t *testing.T) {
	h := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "HEAD" {
			t.Error("HEAD transformed to GET")
		}
		w.Header().Set("Content-Length", "3")
		w.Header().Set("Content-Range", "bytes 1-3/6")
		w.Header().Set("ETag", "\"version\"")
		w.Header().Set("Last-Modified", "Wed, 14 Oct 2026 00:00:00 GMT")
		w.WriteHeader(206)
	})
	r := httptest.NewRequest("HEAD", "/downloads/assets/sample.zip", nil)
	r.Header.Set("Range", "bytes=1-3")
	r.Header.Set("If-Range", "\"version\"")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 206 || w.Body.Len() != 0 || w.Header().Get("Content-Length") != "3" || w.Header().Get("Content-Range") != "bytes 1-3/6" || w.Header().Get("ETag") != "\"version\"" {
		t.Errorf("range HEAD: %d %v %q", w.Code, w.Header(), w.Body.String())
	}
}
func TestClientDisconnectCancelsStreamingUpstream(t *testing.T) {
	canceled := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "131072")
		w.Write(bytes.Repeat([]byte("a"), 65536))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(canceled)
	}))
	defer upstream.Close()
	transport := transportFunc(func(r *http.Request) (*http.Response, error) {
		c := r.Clone(r.Context())
		u, _ := url.Parse(upstream.URL)
		c.URL = u
		return http.DefaultTransport.RoundTrip(c)
	})
	h := newRelay(&http.Client{Transport: transport}, map[string]asset{"sample.zip": {Name: "sample.zip", Size: 131072}})
	server := httptest.NewServer(h)
	defer server.Close()
	response, err := server.Client().Get(server.URL + "/downloads/assets/sample.zip")
	if err != nil {
		t.Fatal(err)
	}
	one := make([]byte, 1)
	if _, err := response.Body.Read(one); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	select {
	case <-canceled:
	case <-time.After(3 * time.Second):
		t.Fatal("client disconnect did not cancel upstream")
	}
}
func TestRedirectDoesNotCopySensitiveHeaders(t *testing.T) {
	first := httptest.NewRequest("GET", "https://github.com"+upstreamPrefix+"sample.zip", nil)
	first.Header.Set("Cookie", "secret")
	first.Header.Set("Authorization", "secret")
	first.Header.Set("X-API-Key", "secret")
	first.Header.Set("Range", "bytes=1-3")
	first.Header.Set("If-Range", "\"v1\"")
	first.Header.Set("User-Agent", "relay")
	first.Header.Set("Accept-Encoding", "identity")
	next := httptest.NewRequest("GET", "https://release-assets.githubusercontent.com/path?sig=secret", nil)
	next.Header = first.Header.Clone()
	if err := productionClient().CheckRedirect(next, []*http.Request{first}); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"Cookie", "Authorization", "X-API-Key"} {
		if next.Header.Get(key) != "" {
			t.Errorf("redirect leaks %s", key)
		}
	}
	for _, key := range []string{"Range", "If-Range", "User-Agent", "Accept-Encoding"} {
		if next.Header.Get(key) != first.Header.Get(key) {
			t.Errorf("redirect drops %s", key)
		}
	}
}

func TestProductionClientDoesNotUseEnvironmentProxy(t *testing.T) {
	transport, ok := productionClient().Transport.(*http.Transport)
	if !ok {
		t.Fatal("expected standard HTTP transport")
	}
	if transport.Proxy != nil {
		t.Fatal("fixed-host relay must not route via arbitrary environment proxy")
	}
	if !transport.DisableCompression {
		t.Fatal("automatic decompression must be disabled")
	}
	if transport.TLSClientConfig != nil && transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("TLS verification disabled")
	}
}
