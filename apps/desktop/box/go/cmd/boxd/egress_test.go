//go:build linux

package main

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestAllowedHost(t *testing.T) {
	for host, want := range map[string]bool{
		"registry.npmjs.org": true, "PyPI.org.": true, "files.pythonhosted.org": true, "static.crates.io": true,
		"proxy.golang.org": true, "repo.packagist.org": true,
		"api.github.com": false, "github.com": false, "raw.githubusercontent.com": false, "evil.registry.npmjs.org.attacker.io": false,
		"x.fly.dev": false, "api.crossref.org": false, "127.0.0.1": false, "": false,
	} {
		if got := allowedHost(host); got != want {
			t.Errorf("allowedHost(%q) = %v, want %v", host, got, want)
		}
	}
}

func startProxy(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(proxy)}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return ln.Addr().String()
}

func TestProxyRefusesFast(t *testing.T) {
	addr := startProxy(t)
	for _, req := range []string{
		"CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\n\r\n",
		"CONNECT registry.npmjs.org:22 HTTP/1.1\r\nHost: registry.npmjs.org:22\r\n\r\n",
		"GET http://zhihu.com/ HTTP/1.1\r\nHost: zhihu.com\r\n\r\n",
	} {
		start := time.Now()
		c, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		io.WriteString(c, req)
		res, err := http.ReadResponse(bufio.NewReader(c), nil)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		c.Close()
		if res.StatusCode != 403 || !strings.Contains(string(body), "is blocked in this environment") {
			t.Errorf("%q: %d %q", req, res.StatusCode, body)
		}
		if time.Since(start) > time.Second {
			t.Errorf("%q: refusal took %v", req, time.Since(start))
		}
	}
}

func TestEgressEnvOnlyUnderFarm(t *testing.T) {
	cfg := config{home: "/root", baseEnv: []string{"PATH=/usr/bin"}}
	for _, kv := range commandEnv(cfg, nil) {
		if strings.Contains(strings.ToLower(kv), "proxy") {
			t.Fatalf("normal box got %s", kv)
		}
	}
	egressPort.Store(4321)
	t.Cleanup(func() { egressPort.Store(0) })
	env := strings.Join(commandEnv(cfg, map[string]string{"HTTPS_PROXY": "http://elsewhere"}), "\n")
	for _, want := range []string{"HTTPS_PROXY=http://127.0.0.1:4321", "https_proxy=http://127.0.0.1:4321", "NO_PROXY=localhost,127.0.0.1,::1", "npm_config_https_proxy=http://127.0.0.1:4321"} {
		if !strings.Contains(env, want+"\n") {
			t.Errorf("farm env lacks %s", want)
		}
	}
}
