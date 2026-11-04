//go:build linux

// Farm egress (BOXD_EGRESS=farm): the agent's commands run in a network
// namespace of their own that has only loopback, so nothing in the box
// reaches the internet directly (git remotes, curl, requests.get, fetch all
// find no route or no DNS). boxd itself stays on the box's network: the
// launcher still reaches it, and it runs a small HTTP/CONNECT proxy whose
// listener is inside the commands' namespace (127.0.0.1) and whose dials are
// outside it. The proxy lets through the package registries in farmAllow
// and answers 403 with a readable body for every other host, at once.
// Commands get HTTP(S)_PROXY and the package managers' proxy settings, and
// shims for git, curl and wget (offlineBin) that print the same line for a
// remote they cannot reach instead of a bare DNS or proxy error.
//
// Fail closed: where boxd may not make a namespace (a container without
// CAP_SYS_ADMIN), it refuses to start; nothing runs with the network open.
package main

import (
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

// farmAllow: the hosts a farm box reaches (exact host names), the one list for the proxy and
// the shims: add a host here. Everything else, GitHub's hosts included, is refused.
var farmAllow = []string{
	// npm / node
	"registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com", "nodejs.org",
	// Python
	"pypi.org", "pypi.python.org", "files.pythonhosted.org", "releases.astral.sh", "conda.anaconda.org",
	// Rust
	"crates.io", "index.crates.io", "static.crates.io", "static.rust-lang.org",
	// Go
	"proxy.golang.org", "sum.golang.org",
	// PHP
	"packagist.org", "repo.packagist.org",
	// Ruby
	"rubygems.org", "index.rubygems.org",
	// JVM
	"repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org", "plugins-artifacts.gradle.org", "services.gradle.org", "downloads.gradle.org",
	// Others
	"api.nuget.org", "pub.dev", "jsr.io", "deno.land", "repo.hex.pm", "builds.hex.pm",
	// Debian (the box images' apt)
	"deb.debian.org", "security.debian.org",
	// Install-time downloads (prisma, playwright, puppeteer)
	"binaries.prisma.sh", "cdn.playwright.dev", "playwright.download.prss.microsoft.com", "playwright.azureedge.net",
	"playwright-akamai.azureedge.net", "playwright-verizon.azureedge.net", "storage.googleapis.com",
}

// The proxy's port inside the commands' namespace (0: no farm egress) and that namespace (-1: none).
var (
	egressPort atomic.Int64
	egressNS   = -1
)

// offlineLine: what a refused call says (the proxy's 403 body, the shims).
func offlineLine(host string) string {
	return "omnirush: " + host + " is not reachable: this session is offline, so mock the service (package installs from the registries still work)"
}

// offlineBin: the shims' folder, first on the commands' PATH (/opt/omnirush is left out of snapshots).
var offlineBin = "/opt/omnirush/offline/bin"

// unshareNet makes the calling thread's network namespace (a variable: tests make it fail).
var unshareNet = func() error { return syscall.Unshare(syscall.CLONE_NEWNET) }

// setns(2): not in package syscall (the box helpers are built for amd64 and arm64).
var sysSetns = map[string]uintptr{"amd64": 308, "arm64": 268}[runtime.GOARCH]

func allowedHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	for _, a := range farmAllow {
		if host == a {
			return true
		}
	}
	return false
}

// startEgress makes the commands' namespace and starts the proxy in it.
func startEgress(mode string) error {
	if mode != "farm" {
		return fmt.Errorf("unknown BOXD_EGRESS %q", mode)
	}
	type made struct {
		ln  net.Listener
		ns  int
		err error
	}
	ch := make(chan made, 1)
	go func() {
		// Never unlocked: this thread's namespace changes, so the runtime drops it at the end.
		runtime.LockOSThread()
		if err := unshareNet(); err != nil {
			ch <- made{err: fmt.Errorf("this sandbox cannot keep the session offline (no network namespace: %w)", err)}
			return
		}
		if err := loopbackUp(); err != nil {
			ch <- made{err: fmt.Errorf("loopback: %w", err)}
			return
		}
		ns, err := syscall.Open("/proc/thread-self/ns/net", syscall.O_RDONLY|syscall.O_CLOEXEC, 0)
		if err != nil {
			ch <- made{err: err}
			return
		}
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		ch <- made{ln, ns, err}
	}()
	m := <-ch
	if m.err != nil {
		return m.err
	}
	if err := writeShims(offlineBin); err != nil {
		return fmt.Errorf("shims: %w", err)
	}
	egressNS = m.ns
	egressPort.Store(int64(m.ln.Addr().(*net.TCPAddr).Port))
	go (&http.Server{Handler: http.HandlerFunc(proxy), ReadHeaderTimeout: 30 * time.Second}).Serve(m.ln)
	log.Printf("egress: farm proxy on 127.0.0.1:%d, commands in their own network", egressPort.Load())
	return nil
}

// loopbackUp sets lo up in the current (new) network namespace.
func loopbackUp() error {
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	var ifr [40]byte // struct ifreq: name[16], then flags (short)
	copy(ifr[:], "lo")
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), syscall.SIOCGIFFLAGS, uintptr(unsafe.Pointer(&ifr[0]))); e != 0 {
		return e
	}
	*(*uint16)(unsafe.Pointer(&ifr[16])) |= syscall.IFF_UP
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), syscall.SIOCSIFFLAGS, uintptr(unsafe.Pointer(&ifr[0]))); e != 0 {
		return e
	}
	return nil
}

// inNet runs fn on a thread in the commands' namespace (a process fn starts is born there);
// without farm egress, fn runs as is.
func inNet(fn func() error) error {
	if egressNS < 0 {
		return fn()
	}
	ch := make(chan error, 1)
	go func() {
		runtime.LockOSThread() // never unlocked: the runtime drops the thread when this goroutine ends
		if _, _, e := syscall.Syscall(sysSetns, uintptr(egressNS), syscall.CLONE_NEWNET, 0); e != 0 {
			ch <- fmt.Errorf("enter the sandbox network: %w", e)
			return
		}
		ch <- fn()
	}()
	return <-ch
}

// egressEnv: what each command gets so the tools that honour a proxy use the farm proxy.
func egressEnv() map[string]string {
	port := egressPort.Load()
	if port == 0 {
		return nil
	}
	url := "http://127.0.0.1:" + strconv.FormatInt(port, 10)
	noProxy := "localhost,127.0.0.1,::1"
	return map[string]string{
		"HTTP_PROXY": url, "HTTPS_PROXY": url, "http_proxy": url, "https_proxy": url,
		"NO_PROXY": noProxy, "no_proxy": noProxy,
		"npm_config_proxy": url, "npm_config_https_proxy": url,
		"YARN_HTTP_PROXY": url, "YARN_HTTPS_PROXY": url,
		"PIP_PROXY": url, "CARGO_HTTP_PROXY": url,
		"GOPROXY": "https://proxy.golang.org", // no ",direct": a module not on the proxy fails with its message
	}
}

func blocked(w http.ResponseWriter, host string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Omnirush-Blocked", host)
	w.WriteHeader(http.StatusForbidden)
	fmt.Fprintln(w, offlineLine(host))
}

// hopHeaders: one connection's own headers, never passed on (RFC 9110 7.6.1), with those Connection names.
var hopHeaders = []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authorization", "Proxy-Authenticate", "Te", "Trailer", "Transfer-Encoding", "Upgrade"}

func dropHop(h http.Header) {
	for _, v := range h.Values("Connection") {
		for _, name := range strings.Split(v, ",") {
			h.Del(strings.TrimSpace(name))
		}
	}
	for _, name := range hopHeaders {
		h.Del(name)
	}
}

var direct = &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 15 * time.Second}).DialContext, ResponseHeaderTimeout: 60 * time.Second}

func proxy(w http.ResponseWriter, r *http.Request) {
	host, port := r.Host, ""
	if h, p, err := net.SplitHostPort(r.Host); err == nil {
		host, port = h, p
	}
	if r.Method == http.MethodConnect {
		if port != "443" || !allowedHost(host) {
			log.Printf("egress: blocked CONNECT %s", r.Host)
			blocked(w, host)
			return
		}
		upstream, err := net.DialTimeout("tcp", r.Host, 15*time.Second)
		if err != nil {
			http.Error(w, "omnirush: "+err.Error(), http.StatusBadGateway)
			return
		}
		client, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			upstream.Close()
			return
		}
		_, _ = io.WriteString(client, "HTTP/1.1 200 Connection established\r\n\r\n")
		go func() { _, _ = rw.Reader.WriteTo(upstream); upstream.(*net.TCPConn).CloseWrite() }()
		_, _ = io.Copy(client, upstream)
		client.Close()
		upstream.Close()
		return
	}
	// A plain http:// request through the proxy (apt, some pip mirrors).
	if r.URL.Scheme != "http" || (port != "" && port != "80") || !allowedHost(host) {
		log.Printf("egress: blocked %s %s", r.Method, r.URL.Redacted())
		blocked(w, host)
		return
	}
	r.RequestURI = ""
	dropHop(r.Header)
	res, err := direct.RoundTrip(r)
	if err != nil {
		http.Error(w, "omnirush: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer res.Body.Close()
	dropHop(res.Header)
	for k, vs := range res.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, res.Body)
}

// netProc: where the commands' network's /proc files are, read from a thread in it.
func netProc() string {
	if egressNS < 0 {
		return "/proc/net/"
	}
	return "/proc/thread-self/net/"
}

// writeShims puts git, curl and wget into dir: a call to a remote that is not a farm host (nor
// this box's loopback) prints offlineLine and fails; every other call runs the real program.
func writeShims(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	lib := strings.NewReplacer("@DIR@", dir, "@ALLOW@", strings.Join(farmAllow, " "), "@LINE@", offlineLine("$1")).Replace(shimLib)
	for name, body := range map[string]string{"git": shimGit, "curl": shimFetch, "wget": shimFetch} {
		code := "7"
		if name == "wget" {
			code = "4"
		}
		text := "#!/bin/bash\n# OmniRush offline shim (farm runs; boxd egress.go).\n" + lib + strings.NewReplacer("@TOOL@", name, "@CODE@", code).Replace(body)
		tmp := filepath.Join(dir, "."+name+".tmp")
		if err := os.WriteFile(tmp, []byte(text), 0o755); err != nil {
			return err
		}
		if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
			return err
		}
	}
	return nil
}

const shimLib = `ALLOW="@ALLOW@"
SHIMS=":@DIR@:"
without_shims() { local p=":$PATH:"; p=${p//"$SHIMS"/:}; p=${p#:}; printf '%s' "${p%:}"; }
real() { PATH=$(without_shims); export PATH; exec "$@"; }
refuse() { echo "@LINE@" >&2; exit "$2"; }
# host_of URL: the host of scheme://[user@]host[:port]/... or [user@]host:path (scp-like); "" for a local path.
host_of() {
  local u=$1 h
  case "$u" in
    file://*) return ;;
    *://*) h=${u#*://}; h=${h%%/*}; h=${h%%\?*}; h=${h##*@} ;;
    *:*) h=${u%%:*}; case "$h" in */*|"") return ;; esac; h=${h##*@} ;;
    *) return ;;
  esac
  case "$h" in \[*) h=${h#[}; h=${h%%]*} ;; *) h=${h%%:*} ;; esac
  printf '%s' "${h,,}"
}
reachable() {
  case "$1" in ""|localhost|*.localhost|127.*|::1|0.0.0.0|omnirush-box) return 0 ;; esac
  local a; for a in $ALLOW; do [ "$1" = "$a" ] && return 0; done
  return 1
}
`

const shimFetch = `for a in "$@"; do
  case "$a" in --url=*) a=${a#--url=} ;; esac
  case "${a,,}" in http://*|https://*|ftp://*|ftps://*) h=$(host_of "$a"); reachable "$h" || refuse "$h" @CODE@ ;; esac
done
real @TOOL@ "$@"
`

const shimGit = `args=("$@"); i=0
while [ $i -lt ${#args[@]} ]; do
  case "${args[$i]}" in
    -C|-c|--git-dir|--work-tree|--namespace|--config-env) i=$((i + 2)) ;;
    -*) i=$((i + 1)) ;;
    *) break ;;
  esac
done
sub=${args[$i]}; pre=("${args[@]:0:$i}"); rest=("${args[@]:$((i + 1))}")
gitc() { (PATH=$(without_shims); git "${pre[@]}" "$@" 2>/dev/null); }
check() { local h; h=$(host_of "$1"); reachable "$h" || refuse "$h" 128; }
case "$sub" in
  clone|fetch|pull|push|ls-remote|submodule)
    # The repository: any scheme://... argument, and the first plain argument (a URL, a
    # [user@]host:path, or a remote's name); later ones are refspecs or folders.
    first=; j=0
    while [ $j -lt ${#rest[@]} ]; do
      a=${rest[$j]}; j=$((j + 1))
      case "$a" in
        *://*) check "$a"; [ -z "$first" ] && first=$a; continue ;;
        --depth|-b|--branch|-o|--origin|-j|--jobs|--reference|--reference-if-able|--template|-u|--upload-pack|--receive-pack|--exec|--filter|--server-option|-c|--config|--separate-git-dir|--shallow-since|--shallow-exclude|--recurse-submodules-default) j=$((j + 1)); continue ;;
        -*) continue ;;
      esac
      [ -n "$first" ] && continue
      first=$a
      if [ -n "$(host_of "$a")" ]; then check "$a"; else url=$(gitc config --get "remote.$a.url"); [ -n "$url" ] && check "$url"; fi
    done
    if [ "$sub" = submodule ]; then
      case " ${rest[*]} " in *" update "*)
        top=$(gitc rev-parse --show-toplevel)
        [ -n "$top" ] && [ -f "$top/.gitmodules" ] && while read -r _ url; do check "$url"; done < <(gitc config -f "$top/.gitmodules" --get-regexp '^submodule\..*\.url$') ;;
      esac
    elif [ -z "$first" ] && [ "$sub" != clone ]; then
      # No remote named: the branch's own, else origin.
      br=$(gitc symbolic-ref --short -q HEAD); rem=$(gitc config --get "branch.$br.remote"); url=$(gitc config --get "remote.${rem:-origin}.url")
      [ -n "$url" ] && check "$url"
    fi ;;
esac
real git "$@"
`
