package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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
			if path == "/downloads/" {
				// Only the embedded local screenshot may load; remote images and scripts stay denied.
				wantCSP := "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
				if got := w.Header().Get("Content-Security-Policy"); got != wantCSP {
					t.Errorf("%s page CSP: got %q, want %q", method, got, wantCSP)
				}
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
		"yitoken-studio-0.1.0-alpha.2-setup.exe", "YITOKEN.Studio-0.1.0-alpha.2.AppImage",
		"yitoken-studio-0.1.0-alpha.2-arm64-mac.dmg", "yitoken-studio-0.1.0-alpha.2-arm64-mac.zip",
		"yitoken-studio-0.1.0-alpha.2-x64-mac.dmg", "yitoken-studio-0.1.0-alpha.2-x64-mac.zip",
	} {
		if len(regexp.MustCompile(`<a\b[^>]*href="/downloads/assets/`+regexp.QuoteMeta(name)+`"[^>]*>`).FindAllString(page, -1)) != 1 {
			t.Errorf("missing installer download %s", name)
		}
	}
	for _, path := range []string{"/downloads/assets/yitoken-studio-0.1.0-alpha.2-source.tar.gz", "/downloads/relay-source.tar.gz"} {
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
	// Inline emphasis and line breaks may change without changing the approved visible message.
	visibleText := html.UnescapeString(regexp.MustCompile(`<[^>]*>`).ReplaceAllString(page, ""))
	for _, want := range []string{"从剧本和分镜，到一部完整视频。", "选择系统下载", "选择你的版本", "第一次使用，三步就绪。", "安装桌面客户端", "填入自己的 API Key", "创作片段，导出整片", "0.1.0-alpha.2", "使用你自己获取的 API Key", "客户端不附赠运营方 Key", "主动 AI 生成按本人账户额度计费"} {
		if !strings.Contains(visibleText, want) {
			t.Errorf("missing visible download guidance %s", want)
		}
	}
	for _, want := range []string{`href="#platforms"`, `id="platforms"`, `id="usage-guide"`} {
		if !strings.Contains(page, want) {
			t.Errorf("missing download navigation %s", want)
		}
	}
	t.Run("original screenshot", func(t *testing.T) {
		images := regexp.MustCompile(`<img\b[^>]*>`).FindAllString(page, -1)
		if len(images) != 1 {
			t.Fatalf("download page must display one original client screenshot, got %d images", len(images))
		}
		image := images[0]
		if !regexp.MustCompile(`\bclass="[^"]*\bd2-real-image\b[^"]*"`).MatchString(image) {
			t.Error("original client screenshot must be the visible hero image")
		}
		if regexp.MustCompile(`(?i)\s(?:hidden(?:\s|=|>)|aria-hidden\s*=\s*["']true["'])|\b(?:display\s*:\s*none|visibility\s*:\s*hidden)`).MatchString(image) {
			t.Error("original screenshot must not be hidden")
		}
		if !regexp.MustCompile(`\balt="[^"]+"`).MatchString(image) {
			t.Error("client screenshot needs meaningful alternative text")
		}
		source := regexp.MustCompile(`\bsrc="data:image/jpeg;base64,([A-Za-z0-9+/=]+)"`).FindStringSubmatch(image)
		if len(source) != 2 {
			t.Fatal("original client screenshot must be a self-contained JPEG, not a remote image")
		}
		original, err := base64.StdEncoding.DecodeString(source[1])
		if err != nil {
			t.Fatal(err)
		}
		const originalSHA256 = "39effba03889a476fabc71d0b0fef00e7d57c3eb1075bccbf561dcad9b44c349"
		if got := fmt.Sprintf("%x", sha256.Sum256(original)); got != originalSHA256 {
			t.Errorf("client screenshot was altered: SHA256 %s, want %s", got, originalSHA256)
		}
		for _, folded := range regexp.MustCompile(`(?s)<details\b[^>]*>.*?</details>`).FindAllString(page, -1) {
			if strings.Contains(folded, image) {
				t.Error("original client screenshot must be visible without opening disclosure panels")
			}
		}
	})
	if strings.Contains(page, "beta-pill") || strings.Contains(page, "预发布 · 非稳定版") || strings.Contains(page, "install-risk") || strings.Contains(page, "安装之前请知道") || strings.Contains(page, `class="notice"`) {
		t.Error("removed installation and prerelease warning badges must not return")
	}
	for _, unwanted := range []string{"待批准", "PROPOSED LAYOUT", "方案注释", "studio-mock", "设计选择", "data-original-href", "data-prototype-installer", "<script", "<form", "未签名程序可能出现系统信誉提示", "不要关闭系统防护或绕过安全校验", "请先备份现有项目和素材"} {
		if strings.Contains(page, unwanted) {
			t.Errorf("public download page contains proposal or active content %s", unwanted)
		}
	}
	steps := regexp.MustCompile(`(?s)<ol\b[^>]*>.*?</ol>`).FindString(page)
	if len(regexp.MustCompile(`<li\b[^>]*>`).FindAllString(steps, -1)) != 3 {
		t.Error("usage guide must expose exactly three ordered steps")
	}
	stepText := html.UnescapeString(regexp.MustCompile(`<[^>]*>`).ReplaceAllString(steps, ""))
	previous := -1
	for _, title := range []string{"安装桌面客户端", "填入自己的 API Key", "创作片段，导出整片"} {
		position := strings.Index(stepText, title)
		if position <= previous {
			t.Errorf("usage guide must present %q in install, configure, create order", title)
		}
		previous = position
	}
	installerLinks := regexp.MustCompile(`<a\b[^>]*href="/downloads/assets/[^"/]+\.(?:exe|AppImage|dmg|zip)"[^>]*>`)
	if len(installerLinks.FindAllString(page, -1)) != 6 {
		t.Error("download page must offer exactly the six existing installer links")
	}
	for _, link := range installerLinks.FindAllString(page, -1) {
		target := regexp.MustCompile(`(?i)\starget\s*=\s*["']([^"']*)["']`).FindStringSubmatch(link)
		if regexp.MustCompile(`(?i)\sdownload(?:\s|=|>)`).MatchString(link) || len(target) == 2 && target[1] != "_self" {
			t.Error("installer links must navigate in the current tab without automatic download attributes")
		}
	}
	if regexp.MustCompile(`(?i)<meta\b[^>]*http-equiv\s*=\s*["']refresh["']|\son[a-z]+\s*=`).MatchString(page) {
		t.Error("download page must not automatically navigate or execute event handlers")
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
		"本版为 alpha 预发布", "macOS 为完整 ad-hoc 本地签名（非 Developer ID）", "macOS 公证：未公证",
		"模型列表 / 模拟协议测试不代表真实生成成功", "Windows 原生安装与系统加密、付费生成尚未完成验收",
		"本版本四平台发布构建与安装包校验已通过", "不代表所有系统兼容性或付费生成已经验证", "不等于 Apple 信任签名或 Gatekeeper 放行",
		"720p / 1080p", "16:9 / 9:16", "30fps", "H.264 / AAC", "无音轨补静音", "不同比例留黑边、不拉伸",
		"字幕", "BGM", "转场", "裁剪", "多轨编辑", "在线项目分享", "200", "10 分钟", "2 小时", "512MiB", "2GiB",
		"取消不删原素材，不覆盖已有输出", "新的本地保存位置", "等待实际验证成功", "所选 AI 服务商",
		"公开图床默认关闭", "开启前须明确同意", "勿上传未授权或机密内容", "Key 仅会话有效", "不回退明文持久化",
		"网络提交结果未知时不自动重复提交", "先核对后台任务", "已校验安装包从本站服务器直接下载", "未镜像对应源码或其他资产仍由本站转发 GitHub", "完整下载后自行核验",
		"上游不可达、链接校验失败或并发已满", "兼容路径 SHA256SUMS-GITHUB.txt 返回同一份真实校验清单", "原作者与版权声明保留", "AGPL-3.0-or-later",
		"FFmpeg / x264", "GPL", "精确对应源码", "第三方许可证继续适用", "品牌改编不代表上游作者背书", "未进行法律或专利许可认证",
	} {
		if !strings.Contains(strings.Join(folded, "\n"), fact) {
			t.Errorf("missing folded safety or release fact %s", fact)
		}
	}
	for _, metadata := range []string{
		"200,388,537 bytes", "191.1 MiB", "9c34868a1972c9a312bca5b9fb6eb09145dc5cafe4c9c20795c9bda1a600f63d",
		"196,874,571 bytes", "187.8 MiB", "bbff1c612b3ffeb057c56a209f266fd9f83eb0071732c89bb5d4b33082e19719",
		"197,025,250 bytes", "187.9 MiB", "76bf40bc5d8c8395cd4db15dbdcda14e96a245203592a05cd997665602f102ad",
		"168,150,633 bytes", "160.4 MiB", "d2124b1cd0b89dc702e4a68075edeb6cf90cce755fe2a2aacc6e659cf77a66e7",
		"204,701,049 bytes", "195.2 MiB", "d6ec72220b27ca7364892f86fc67a3e2fce4e10e0ed43f61d52d39c33099aa5d",
		"204,851,265 bytes", "195.4 MiB", "46263b326235b4e2af19f277dea94d0f6e1d948857a4190133ec7b16ae79d0e3",
		"默认 API 为 YITOKEN", "客户端不附赠运营方 Key", "本机拼接已有视频不新增 AI 生成费用",
		`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"`,
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

type mirrorConfig interface {
	loadMirror(string) error
	closeMirror() error
}

func mirrorFixture(t *testing.T) (*relay, string, mirrorConfig) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "sample.zip"), []byte("abcdef"), 0600); err != nil {
		t.Fatal(err)
	}
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte("abcdef")))
	h := newRelay(&http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) {
		t.Error("verified mirror must not call upstream")
		return nil, errors.New("unexpected upstream")
	})}, map[string]asset{"sample.zip": {Name: "sample.zip", Size: 6, SHA256: digest}})
	config, ok := any(h).(mirrorConfig)
	if !ok {
		t.Fatal("relay does not support a verified read-only mirror")
	}
	if err := config.loadMirror(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = config.closeMirror() })
	return h, dir, config
}

func TestVerifiedMirrorDownloadsAndValidation(t *testing.T) {
	h, _, _ := mirrorFixture(t)
	etag := `"sha256-` + fmt.Sprintf("%x", sha256.Sum256([]byte("abcdef"))) + `"`
	for _, tc := range []struct {
		method, path, interval, validator string
		status                            int
		body, length, contentRange        string
	}{
		{"GET", "/downloads/assets/sample.zip", "", "", 200, "abcdef", "6", ""},
		{"HEAD", "/downloads/assets/sample.zip", "", "", 200, "", "6", ""},
		{"GET", "/downloads/assets/sample.zip", "bytes=1-3", "", 206, "bcd", "3", "bytes 1-3/6"},
		{"HEAD", "/downloads/assets/sample.zip", "bytes=1-3", etag, 206, "", "3", "bytes 1-3/6"},
		{"GET", "/downloads/assets/sample.zip", "bytes=-2", etag, 206, "ef", "2", "bytes 4-5/6"},
		{"GET", "/downloads/assets/sample.zip", "bytes=3-", "", 206, "def", "3", "bytes 3-5/6"},
		{"GET", "/downloads/assets/sample.zip", "bytes=1-3", `"old"`, 200, "abcdef", "6", ""},
		{"GET", "/downloads/assets/sample.zip", "bytes=1-3", "W/" + etag, 200, "abcdef", "6", ""},
		{"GET", "/downloads/assets/sample.zip", "bytes=1-3", "Wed, 14 Oct 2026 00:00:00 GMT", 200, "abcdef", "6", ""},
		{"GET", "/downloads/assets/sample.zip", "bytes=6-", "", 416, "", "", "bytes */6"},
		{"GET", "/downloads/assets/sample.zip", "bytes=0-1,3-4", "", 416, "", "", "bytes */6"},
		{"POST", "/downloads/assets/sample.zip", "", "", 405, "", "", ""},
		{"GET", "/downloads/assets/sample.zip?url=x", "", "", 400, "", "", ""},
		{"GET", "/downloads/assets/%73ample.zip", "", "", 400, "", "", ""},
		{"GET", "/downloads/assets/../sample.zip", "", "", 404, "", "", ""},
		{"GET", "/downloads/assets/unknown.zip", "", "", 404, "", "", ""},
	} {
		t.Run(tc.method+tc.path+tc.interval+tc.validator, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, nil)
			r.Header.Set("Range", tc.interval)
			r.Header.Set("If-Range", tc.validator)
			r.Header.Set("Authorization", "Bearer private")
			r.Header.Set("Cookie", "private=1")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status || w.Header().Get("Content-Range") != tc.contentRange {
				t.Fatalf("status/range: %d %v", w.Code, w.Header())
			}
			if tc.status < 300 && (w.Body.String() != tc.body || w.Header().Get("Content-Length") != tc.length || w.Header().Get("ETag") != etag || w.Header().Get("Content-Type") != "application/octet-stream" || w.Header().Get("Content-Encoding") != "identity" || w.Header().Get("Content-Disposition") != "attachment; filename=sample.zip") {
				t.Errorf("incorrect local bytes or headers: %q %v", w.Body.String(), w.Header())
			}
			if w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Cache-Control") != "no-store, no-transform" || w.Header().Get("Location") != "" || w.Header().Get("Set-Cookie") != "" || strings.Contains(w.Body.String(), "private") {
				t.Error("local response weakened security headers")
			}
		})
	}
	for range cap(h.slots) {
		h.slots <- struct{}{}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/downloads/assets/sample.zip", nil))
	if w.Code != 503 || w.Header().Get("Retry-After") == "" {
		t.Error("local mirror bypassed shared concurrency limit")
	}
	for range cap(h.slots) {
		<-h.slots
	}
}

func TestMirrorStartupIntegrityAndFallback(t *testing.T) {
	for _, mode := range []string{"missing-root", "empty", "wrong-size", "wrong-hash", "directory-file", "symlink-file", "symlink-root", "outside-name"} {
		t.Run(mode, func(t *testing.T) {
			h, _, config := mirrorFixture(t)
			_ = config.closeMirror()
			dir := t.TempDir()
			file := filepath.Join(dir, "sample.zip")
			if mode != "empty" && mode != "missing-root" {
				if err := os.WriteFile(file, []byte("abcdef"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			switch mode {
			case "missing-root":
				dir = filepath.Join(dir, "missing")
			case "wrong-size":
				if err := os.WriteFile(file, []byte("abc"), 0600); err != nil {
					t.Fatal(err)
				}
			case "wrong-hash":
				if err := os.WriteFile(file, []byte("ABCDEF"), 0600); err != nil {
					t.Fatal(err)
				}
			case "directory-file":
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(file, 0700); err != nil {
					t.Fatal(err)
				}
			case "symlink-file":
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Join(t.TempDir(), "outside.zip"), file); err != nil {
					t.Fatal(err)
				}
			case "symlink-root":
				link := filepath.Join(t.TempDir(), "root-link")
				if err := os.Symlink(dir, link); err != nil {
					t.Fatal(err)
				}
				dir = link
			case "outside-name":
				h.assets["../outside.zip"] = asset{Name: "../outside.zip", Size: 6}
			}
			if config.loadMirror(dir) == nil {
				t.Fatal("invalid mirror accepted: " + mode)
			}
		})
	}
	h, dir, config := mirrorFixture(t)
	_ = config.closeMirror()
	if err := os.WriteFile(filepath.Join(dir, "unlisted.zip"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	h.assets["missing.zip"] = asset{Name: "missing.zip", Size: 6, SHA256: fmt.Sprintf("%x", sha256.Sum256([]byte("abcdef")))}
	if err := config.loadMirror(dir); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	h.client = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.URL.Path != upstreamPrefix+"missing.zip" {
			t.Error("fallback selected wrong path")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, ContentLength: 6, Body: io.NopCloser(strings.NewReader("abcdef"))}, nil
	})}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/downloads/assets/missing.zip", nil))
	if w.Code != 200 || w.Body.String() != "abcdef" || calls.Load() != 1 {
		t.Error("unmirrored asset did not use fixed upstream fallback")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/downloads/assets/unlisted.zip", nil))
	if w.Code != 404 || calls.Load() != 1 {
		t.Error("mirror exposed unlisted file")
	}
}

func TestMirrorChangedFileFailsClosed(t *testing.T) {
	for _, mode := range []string{"remove", "truncate", "replace", "symlink", "same-size-modification"} {
		t.Run(mode, func(t *testing.T) {
			h, dir, _ := mirrorFixture(t)
			file := filepath.Join(dir, "sample.zip")
			switch mode {
			case "remove":
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
			case "truncate":
				if err := os.Truncate(file, 3); err != nil {
					t.Fatal(err)
				}
			case "replace":
				replacement := filepath.Join(dir, "replacement")
				if err := os.WriteFile(replacement, []byte("abcdef"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(replacement, file); err != nil {
					t.Fatal(err)
				}
			case "same-size-modification":
				if err := os.WriteFile(file, []byte("ABCDEF"), 0600); err != nil {
					t.Fatal(err)
				}
				changed := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
				if err := os.Chtimes(file, changed, changed); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Join(t.TempDir(), "outside"), file); err != nil {
					t.Fatal(err)
				}
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "/downloads/assets/sample.zip", nil))
			if w.Code != 503 || w.Header().Get("Retry-After") == "" || w.Body.String() == "abcdef" {
				t.Error("changed verified file must fail closed, not upstream fallback")
			}
		})
	}
}

type mirrorInterruptWriter struct {
	*httptest.ResponseRecorder
	interrupt func()
}

func (w mirrorInterruptWriter) WriteHeader(status int) {
	w.ResponseRecorder.WriteHeader(status)
	w.interrupt()
}

func TestMirrorInterruptedStreamAborts(t *testing.T) {
	for _, mode := range []string{"truncate-after-headers", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			h, dir, _ := mirrorFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			w := mirrorInterruptWriter{ResponseRecorder: httptest.NewRecorder(), interrupt: func() {
				if mode == "cancel" {
					cancel()
				} else if err := os.Truncate(filepath.Join(dir, "sample.zip"), 3); err != nil {
					t.Fatal(err)
				}
			}}
			defer func() {
				if recover() != http.ErrAbortHandler {
					t.Error("interrupted mirror returned successful EOF")
				}
				if len(h.slots) != 0 {
					t.Error("mirror leaked transfer slot")
				}
			}()
			h.ServeHTTP(w, httptest.NewRequest("GET", "/downloads/assets/sample.zip", nil).WithContext(ctx))
		})
	}
}

func TestPublishedAlpha2Metadata(t *testing.T) {
	const version = "0.1.0-alpha.2"
	var document struct {
		Version      string  `json:"version"`
		ReleaseTag   string  `json:"release_tag"`
		SourceCommit string  `json:"source_commit"`
		WorkflowRun  string  `json:"workflow_run"`
		Assets       []asset `json:"assets"`
	}
	if err := json.Unmarshal(manifestDocument, &document); err != nil {
		t.Fatal(err)
	}
	expected := map[string]asset{
		"BUILD-PROVENANCE-linux-x64.json":                   {Name: "BUILD-PROVENANCE-linux-x64.json", Size: 2618, SHA256: "ed87167cbfd4af2999516f26c2b57d0833354b3e26f8a5bb14ce0b9699d074e1"},
		"BUILD-PROVENANCE-mac-arm64.json":                   {Name: "BUILD-PROVENANCE-mac-arm64.json", Size: 3427, SHA256: "276eb57c285079c94df049d68e84fd32e66d56023a6fd9bd66b4ed99a3398a9b"},
		"BUILD-PROVENANCE-mac-x64.json":                     {Name: "BUILD-PROVENANCE-mac-x64.json", Size: 3419, SHA256: "333854abe182c99e881843f7021a3fa27a76e74b9190f31a1be98ad5f1ae6555"},
		"BUILD-PROVENANCE-win-x64.json":                     {Name: "BUILD-PROVENANCE-win-x64.json", Size: 2625, SHA256: "308f5e84321a5c089eece84fca92bbc16d7825c029a8557dd97a87d5d2d40b07"},
		"SHA256SUMS.txt":                                    {Name: "SHA256SUMS.txt", Size: 1254, SHA256: "b33b19c819beb850fa2e20e2c934625264fae7d3e337e1cd2e9342b45dca130d"},
		"YITOKEN.Studio-0.1.0-alpha.2.AppImage":             {Name: "YITOKEN.Studio-0.1.0-alpha.2.AppImage", Size: 200388537, SHA256: "9c34868a1972c9a312bca5b9fb6eb09145dc5cafe4c9c20795c9bda1a600f63d"},
		"yitoken-studio-0.1.0-alpha.2-arm64-mac.dmg":        {Name: "yitoken-studio-0.1.0-alpha.2-arm64-mac.dmg", Size: 196874571, SHA256: "bbff1c612b3ffeb057c56a209f266fd9f83eb0071732c89bb5d4b33082e19719"},
		"yitoken-studio-0.1.0-alpha.2-arm64-mac.zip":        {Name: "yitoken-studio-0.1.0-alpha.2-arm64-mac.zip", Size: 197025250, SHA256: "76bf40bc5d8c8395cd4db15dbdcda14e96a245203592a05cd997665602f102ad"},
		"yitoken-studio-0.1.0-alpha.2-setup.exe":            {Name: "yitoken-studio-0.1.0-alpha.2-setup.exe", Size: 168150633, SHA256: "d2124b1cd0b89dc702e4a68075edeb6cf90cce755fe2a2aacc6e659cf77a66e7"},
		"yitoken-studio-0.1.0-alpha.2-source.tar.gz":        {Name: "yitoken-studio-0.1.0-alpha.2-source.tar.gz", Size: 25536285, SHA256: "d7f9ff7836a49e1c64462c3efc84deef4171fbf28e13c1857431432e18ae335e"},
		"yitoken-studio-0.1.0-alpha.2-source.tar.gz.sha256": {Name: "yitoken-studio-0.1.0-alpha.2-source.tar.gz.sha256", Size: 109, SHA256: "be876fd3bd4eb132a0ffbdbe9020b45351a90092271b418eefdb4219690be4d6"},
		"yitoken-studio-0.1.0-alpha.2-x64-mac.dmg":          {Name: "yitoken-studio-0.1.0-alpha.2-x64-mac.dmg", Size: 204701049, SHA256: "d6ec72220b27ca7364892f86fc67a3e2fce4e10e0ed43f61d52d39c33099aa5d"},
		"yitoken-studio-0.1.0-alpha.2-x64-mac.zip":          {Name: "yitoken-studio-0.1.0-alpha.2-x64-mac.zip", Size: 204851265, SHA256: "46263b326235b4e2af19f277dea94d0f6e1d948857a4190133ec7b16ae79d0e3"},
	}
	if document.Version != version || document.ReleaseTag != "v"+version || document.SourceCommit != "e711d7ae13581871e046af764b0ddd0fec4c8c59" || document.WorkflowRun != "https://github.com/ZonEaseTech/yitoken-studio/actions/runs/39236156020" || len(document.Assets) != len(expected) {
		t.Error("release metadata must match verified alpha2 assets")
	}
	h := newRelay(productionClient(), nil)
	for name, want := range expected {
		if got, ok := h.assets[name]; !ok || got != want {
			t.Errorf("release metadata must match verified alpha2 assets: %s", name)
		}
	}
	var update struct {
		Version              string `json:"version"`
		Signed               bool   `json:"signed"`
		Notarized            bool   `json:"notarized"`
		MacSigning           string `json:"mac_signing"`
		MacSignatureVerified bool   `json:"mac_signature_verified"`
	}
	if err := json.Unmarshal(versionDocument, &update); err != nil {
		t.Fatal(err)
	}
	if update.Version != version || update.Signed || update.Notarized || update.MacSigning != "adhoc" || !update.MacSignatureVerified {
		t.Error("release metadata must match verified alpha2 assets and signing scope")
	}
	page := string(indexPage)
	for name, a := range expected {
		if strings.HasSuffix(name, ".exe") || strings.HasSuffix(name, ".dmg") || strings.HasSuffix(name, ".zip") || strings.HasSuffix(name, ".AppImage") || name == "yitoken-studio-0.1.0-alpha.2-source.tar.gz" {
			for _, value := range []string{name, fmt.Sprintf("%s bytes", humanBytes(a.Size)), fmt.Sprintf("%.1f MiB", float64(a.Size)/1048576), a.SHA256} {
				if !strings.Contains(page, value) {
					t.Errorf("release page metadata mismatch: %s %s", name, value)
				}
			}
		}
	}
	for _, path := range []string{"/downloads/assets/SHA256SUMS.txt", "/downloads/assets/SHA256SUMS-GITHUB.txt"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path+"?bad=1", nil))
		if w.Code != 400 {
			t.Error("checksum alias must retain query validation")
		}
	}
	canonical := h.assets["SHA256SUMS.txt"]
	h.client = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != upstreamPrefix+"SHA256SUMS.txt" {
			t.Error("checksum alias selected wrong upstream")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, ContentLength: canonical.Size, Body: io.NopCloser(strings.NewReader(strings.Repeat("x", int(canonical.Size))))}, nil
	})}
	var bodies [][]byte
	for _, path := range []string{"/downloads/assets/SHA256SUMS.txt", "/downloads/assets/SHA256SUMS-GITHUB.txt"} {
		for _, method := range []string{"GET", "HEAD"} {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(method, path, nil))
			if w.Code != 200 || w.Header().Get("Content-Disposition") != "attachment; filename=SHA256SUMS.txt" {
				t.Error("checksum aliases must return canonical checklist")
			}
			if method == "GET" {
				bodies = append(bodies, w.Body.Bytes())
			} else if w.Body.Len() != 0 {
				t.Error("checksum alias HEAD body")
			}
		}
	}
	if len(bodies) != 2 || !bytes.Equal(bodies[0], bodies[1]) {
		t.Error("checksum alias bytes diverged")
	}
	// A valid-looking but unapproved 14th/name-replacement asset must never expand the public release allowlist.
	saved := manifestDocument
	defer func() { manifestDocument = saved }()
	var broken map[string]any
	if err := json.Unmarshal(saved, &broken); err != nil {
		t.Fatal(err)
	}
	entries := broken["assets"].([]any)
	entries[0].(map[string]any)["name"] = "unexpected-alpha2.txt"
	manifestDocument, _ = json.Marshal(broken)
	func() {
		defer func() {
			if recover() == nil {
				t.Error("modified exact release allowlist accepted")
			}
		}()
		newRelay(productionClient(), nil)
	}()
}

// Human-readable byte counts are part of the public release metadata contract.
func humanBytes(n int64) string {
	value := strconv.FormatInt(n, 10)
	for i := len(value) - 3; i > 0; i -= 3 {
		value = value[:i] + "," + value[i:]
	}
	return value
}
