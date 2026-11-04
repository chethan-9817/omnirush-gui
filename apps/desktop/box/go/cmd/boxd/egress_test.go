//go:build linux

package main

import (
	"bufio"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestAllowedHost(t *testing.T) {
	for host, want := range map[string]bool{
		"registry.npmjs.org": true, "PyPI.org.": true, "files.pythonhosted.org": true, "static.crates.io": true,
		"proxy.golang.org": true, "repo.packagist.org": true,
		"api.github.com": false, "github.com": false, "raw.githubusercontent.com": false, "evil.registry.npmjs.org.attacker.io": false,
		"x.fly.dev": false, "api.crossref.org": false, "127.0.0.1": false, "": false,
		"static.rust-lang.org": true, "releases.astral.sh": true, "storage.googleapis.com": true, "plugins.gradle.org": true, "packagist.org": true,
		"codeload.github.com": false, "objects.githubusercontent.com": false, "downloads.python.org": false, "omnirush.ai": false, "x.storage.googleapis.com": false,
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
		if res.StatusCode != 403 || !strings.Contains(string(body), "is not reachable: this session is offline, so mock the service (package installs from the registries still work)") || strings.Contains(string(body), ":443") {
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
	env := strings.Join(commandEnv(cfg, map[string]string{"HTTPS_PROXY": "http://elsewhere"}), "\n") + "\n"
	for _, want := range []string{"HTTPS_PROXY=http://127.0.0.1:4321", "https_proxy=http://127.0.0.1:4321", "NO_PROXY=localhost,127.0.0.1,::1", "npm_config_https_proxy=http://127.0.0.1:4321"} {
		if !strings.Contains(env, want+"\n") {
			t.Errorf("farm env lacks %s", want)
		}
	}
}

func TestFarmRefusesToStartWithoutNamespace(t *testing.T) {
	old := unshareNet
	unshareNet = func() error { return syscall.EPERM }
	t.Cleanup(func() { unshareNet = old })
	err := startEgress("farm")
	if err == nil || !strings.Contains(err.Error(), "cannot keep the session offline") {
		t.Fatalf("startEgress with no namespace = %v, want a refusal", err)
	}
	if egressPort.Load() != 0 || egressNS >= 0 {
		t.Fatal("a refused start left the proxy or namespace set")
	}
}

func TestDropHop(t *testing.T) {
	h := http.Header{}
	for _, k := range []string{"Connection", "Keep-Alive", "Te", "Trailer", "Transfer-Encoding", "Upgrade", "Proxy-Connection", "X-Custom", "Accept"} {
		h.Set(k, "x")
	}
	h.Set("Connection", "close, X-Custom")
	dropHop(h)
	if len(h) != 1 || h.Get("Accept") != "x" {
		t.Fatalf("after dropHop: %v", h)
	}
}

// The shims, run with fake curl/wget and the real git behind them.
func TestShims(t *testing.T) {
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Skip("no git")
	}
	dir, fake, repo := t.TempDir(), t.TempDir(), t.TempDir()
	for _, name := range []string{"curl", "wget"} {
		os.WriteFile(filepath.Join(fake, name), []byte("#!/bin/sh\necho REAL "+name+" \"$@\"\n"), 0o755)
	}
	os.Symlink(gitBin, filepath.Join(fake, "git"))
	if err := writeShims(dir); err != nil {
		t.Fatal(err)
	}
	env := append(os.Environ(), "PATH="+dir+":"+fake+":/usr/bin:/bin", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	run := func(args ...string) (string, int) {
		cmd := exec.Command("/bin/sh", append([]string{"-c", `exec "$@"`, "sh"}, args...)...) // found on env's PATH
		cmd.Env, cmd.Dir = env, repo
		out, err := cmd.CombinedOutput()
		code := 0
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		}
		return string(out), code
	}
	run("git", "init", "-q", "-b", "main")
	run("git", "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x")
	run("git", "remote", "add", "origin", "https://github.com/octocat/Hello-World.git")
	const line = "is not reachable: this session is offline, so mock the service"
	for _, c := range []struct {
		args    []string
		refused string
		code    int
	}{
		{[]string{"curl", "-sS", "https://api.github.com/zen"}, "api.github.com", 7},
		{[]string{"curl", "-H", "Referer: https://x.org", "http://127.0.0.1:8080/"}, "", 0},
		{[]string{"curl", "https://registry.npmjs.org/left-pad"}, "", 0},
		{[]string{"curl", "--url=https://User@Example.COM:8443/x"}, "example.com", 7},
		{[]string{"wget", "-q", "https://raw.githubusercontent.com/a/b"}, "raw.githubusercontent.com", 4},
		{[]string{"wget", "http://localhost:3000/"}, "", 0},
		{[]string{"git", "clone", "--depth", "1", "https://github.com/octocat/Hello-World.git"}, "github.com", 128},
		{[]string{"git", "clone", "git@github.com:octocat/Hello-World.git"}, "github.com", 128},
		{[]string{"git", "-C", repo, "fetch"}, "github.com", 128},
		{[]string{"git", "pull", "origin", "main:main"}, "github.com", 128},
		{[]string{"git", "push"}, "github.com", 128},
		{[]string{"git", "ls-remote", "https://gitlab.com/a/b"}, "gitlab.com", 128},
		{[]string{"git", "submodule", "add", "https://github.com/a/b"}, "github.com", 128},
		{[]string{"git", "status", "--short"}, "", 0},
		{[]string{"git", "log", "--oneline", "-1"}, "", 0},
		{[]string{"git", "clone", "-q", repo, filepath.Join(t.TempDir(), "copy")}, "", 0},
	} {
		out, code := run(c.args...)
		if c.refused != "" {
			if code != c.code || !strings.Contains(out, "omnirush: "+c.refused+" "+line) {
				t.Errorf("%v: exit %d %q, want a refusal for %s", c.args, code, out, c.refused)
			}
		} else if code != 0 || strings.Contains(out, line) {
			t.Errorf("%v: exit %d %q, want the real program", c.args, code, out)
		}
	}
}
