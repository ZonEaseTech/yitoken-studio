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
	"regexp"
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
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/downloads/", nil))
	page := w.Body.String()
	if len(regexp.MustCompile(`<article\b[^>]*>`).FindAllString(page, -1)) != 4 || strings.Contains(page, "同版本完整客户端源码") {
		t.Error("download grid must contain only the four platform installer cards")
	}
	for _, name := range []string{
		"yitoken-studio-0.1.0-alpha.1-setup.exe", "YITOKEN.Studio-0.1.0-alpha.1.AppImage",
		"yitoken-studio-0.1.0-alpha.1-arm64-mac.dmg", "yitoken-studio-0.1.0-alpha.1-arm64-mac.zip",
		"yitoken-studio-0.1.0-alpha.1-x64-mac.dmg", "yitoken-studio-0.1.0-alpha.1-x64-mac.zip",
	} {
		if len(regexp.MustCompile(`<a\b[^>]*href="/downloads/assets/`+regexp.QuoteMeta(name)+`"[^>]*>`).FindAllString(page, -1)) != 1 {
			t.Errorf("missing installer download %s", name)
		}
	}
	for _, path := range []string{"/downloads/assets/yitoken-studio-0.1.0-alpha.1-source.tar.gz", "/downloads/relay-source.tar.gz"} {
		if !strings.Contains(page, `<a href="`+path+`">`) {
			t.Errorf("source must remain available as a text link, not an installer card: %s", path)
		}
	}
	for _, want := range []string{"Windows x64", "Linux x64", "macOS Apple Silicon", "macOS Intel", "SHA256SUMS-GITHUB.txt", "/downloads/relay-source.tar.gz", "Moyin Creator", "/keys"} {
		if !strings.Contains(page, want) {
			t.Errorf("missing page %s", want)
		}
	}
	if strings.Contains(page, "@@") || strings.Contains(page, "https://fonts") || strings.Contains(page, "<script") {
		t.Error("page requires remote or unrendered content")
	}
}
func TestDownloadPortalGuidance(t *testing.T) {
	w := httptest.NewRecorder()
	newRelay(productionClient(), nil).ServeHTTP(w, httptest.NewRequest("GET", "/downloads/", nil))
	page := w.Body.String()
	for _, want := range []string{`href="#platforms"`, `id="platforms"`, `id="usage-guide"`, "选择系统下载", "三步开始创作", "下载安装", "填写本人 Key", "创作并合成整片", "0.1.0-alpha.1", "预发布", "非稳定版"} {
		if !strings.Contains(page, want) {
			t.Errorf("missing download guidance %s", want)
		}
	}
	if strings.Contains(page, "install-risk") || strings.Contains(page, "安装之前请知道") || strings.Contains(page, `class="notice"`) {
		t.Error("the removed installation warning banner must not return")
	}
	for _, unwanted := range []string{"待批准", "PROPOSED LAYOUT", "方案注释", "studio-mock", "设计选择", "data-original-href", "<script", "<form", "未签名程序可能出现系统信誉提示", "不要关闭系统防护或绕过安全校验", "请先备份现有项目和素材"} {
		if strings.Contains(page, unwanted) {
			t.Errorf("public download page contains proposal or active content %s", unwanted)
		}
	}
	steps := regexp.MustCompile(`(?s)<ol\b[^>]*>.*?</ol>`).FindString(page)
	if len(regexp.MustCompile(`<li\b[^>]*>`).FindAllString(steps, -1)) != 3 {
		t.Error("usage guide must expose exactly three ordered steps")
	}
	installerLinks := regexp.MustCompile(`<a\b[^>]*href="/downloads/assets/[^"/]+\.(?:exe|AppImage|dmg|zip)"[^>]*>`)
	if len(installerLinks.FindAllString(page, -1)) != 6 {
		t.Error("download page must offer exactly the six existing installer links")
	}
	cardInstallers := 0
	for _, card := range regexp.MustCompile(`(?s)<article\b[^>]*>.*?</article>`).FindAllString(page, -1) {
		cardInstallers += len(installerLinks.FindAllString(card, -1))
	}
	if cardInstallers != 6 {
		t.Error("all six installer links must remain inside the four system cards")
	}
	// Safety and acceptance limits stay readable on demand, not as a first-screen banner.
	folded := regexp.MustCompile(`(?s)<details\b[^>]*>.*?</details>`).FindAllString(page, -1)
	for _, fact := range []string{
		"本版为 alpha 预发布", "签名：未签名", "macOS 公证：未公证",
		"模型列表 / 模拟协议测试不代表真实生成成功", "Windows 原生安装与系统加密、付费生成尚未完成验收",
		"19 个测试文件 / 160 项测试通过", "Mac 原生安装已验证", "不代表所有系统兼容性或付费生成已经验证",
		"720p / 1080p", "16:9 / 9:16", "30fps", "H.264 / AAC", "无音轨补静音", "不同比例留黑边、不拉伸",
		"字幕", "BGM", "转场", "裁剪", "多轨编辑", "在线项目分享", "200", "10 分钟", "2 小时", "512MiB", "2GiB",
		"取消不删原素材，不覆盖已有输出", "新的本地保存位置", "等待实际验证成功", "所选 AI 服务商",
		"公开图床默认关闭", "开启前须明确同意", "勿上传未授权或机密内容", "Key 仅会话有效", "不回退明文持久化",
		"网络提交结果未知时不自动重复提交", "先核对后台任务", "本站不缓存安装包", "完整下载后自行核验",
		"上游不可达、链接校验失败或并发已满", "原 SHA256SUMS.txt", "原作者与版权声明保留", "AGPL-3.0-or-later",
		"FFmpeg / x264", "GPL", "精确对应源码", "第三方许可证继续适用", "品牌改编不代表上游作者背书", "未进行法律或专利许可认证",
	} {
		if !strings.Contains(strings.Join(folded, "\n"), fact) {
			t.Errorf("missing folded safety or release fact %s", fact)
		}
	}
	for _, metadata := range []string{
		"168,144,976 bytes", "160.4 MiB", "576655a32159c9b1f96c62a1ca4d132bd94504deda63205356ef4f05a789266f",
		"200,384,647 bytes", "191.1 MiB", "bdd36a58f7cb2c50a37422b176771f68f1088abf572e2ed9f1116f162d2cfcf0",
		"196,821,677 bytes", "187.7 MiB", "17c7da96c40c620411df1e76457f547c5e808ace52986ad1bd869f3fa57d02aa",
		"196,997,949 bytes", "187.9 MiB", "c5534528b8d7eb59909a97996b36267147b689828f3049bb2484e789e8f30d51",
		"202,422,977 bytes", "193.0 MiB", "7b3ca84c609053df1d5d2baa45f1b0a3f9f4b10185ea7656c930cedf62fdce1c",
		"202,608,058 bytes", "193.2 MiB", "cc221d8e6f6ad7fae19c95012cd310f4d0be20575485f8bd75245fbe8807d04c",
		"默认 API 为 YITOKEN", "客户端不附赠运营方 Key", "本机拼接已有视频不新增 AI 生成费用",
		`content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"`,
	} {
		if !strings.Contains(page, metadata) {
			t.Errorf("missing unchanged download metadata or policy %s", metadata)
		}
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
