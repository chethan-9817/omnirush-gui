//go:build linux

// Farm egress (BOXD_EGRESS=farm): the agent's commands run in a network
// namespace of their own that has only loopback, so nothing in the box
// reaches the internet directly (git remotes, curl, requests.get, fetch all
// find no route or no DNS). boxd itself stays on the box's network: the
// launcher still reaches it, and it runs a small HTTP/CONNECT proxy whose
// listener is inside the commands' namespace (127.0.0.1) and whose dials are
// outside it. The proxy lets through the package registries in farmAllow
// and answers 403 with a readable body for every other host, at once.
// Commands get HTTP(S)_PROXY and the package managers' proxy settings.
//
// Where boxd may not make a namespace (a container without CAP_SYS_ADMIN),
// the proxy still runs and the variables are still set, but a program that
// ignores the proxy is not stopped: boxd logs "egress: proxy only".
package main

import (
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

// farmAllow: the hosts the farm proxy lets through (exact, or "*." for any subdomain).
// The registries the farm asked for, plus the mirrors the box images themselves use
// (Debian apt; Node headers for node-gyp; Maven and RubyGems for the java and ruby stacks).
var farmAllow = []string{
	"registry.npmjs.org", "registry.yarnpkg.com",
	"pypi.org", "files.pythonhosted.org",
	"index.crates.io", "static.crates.io", "crates.io",
	"proxy.golang.org", "sum.golang.org",
	"repo.packagist.org",
	"deb.debian.org", "security.debian.org",
	"nodejs.org",
	"repo.maven.apache.org", "repo1.maven.org",
	"rubygems.org", "index.rubygems.org",
}

// The proxy's port inside the commands' namespace (0: no farm egress) and that namespace (-1: none).
var (
	egressPort atomic.Int64
	egressNS   = -1
)

// setns(2): not in package syscall (the box helpers are built for amd64 and arm64).
var sysSetns = map[string]uintptr{"amd64": 308, "arm64": 268}[runtime.GOARCH]

func allowedHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	for _, a := range farmAllow {
		if host == a || strings.HasPrefix(a, "*.") && strings.HasSuffix(host, a[1:]) {
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
		ns := -1
		if err := syscall.Unshare(syscall.CLONE_NEWNET); err != nil {
			log.Printf("egress: proxy only (no network namespace: %v)", err)
		} else if err := loopbackUp(); err != nil {
			ch <- made{err: fmt.Errorf("loopback: %w", err)}
			return
		} else if ns, err = syscall.Open("/proc/thread-self/ns/net", syscall.O_RDONLY|syscall.O_CLOEXEC, 0); err != nil {
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
	egressNS = m.ns
	egressPort.Store(int64(m.ln.Addr().(*net.TCPAddr).Port))
	go (&http.Server{Handler: http.HandlerFunc(proxy), ReadHeaderTimeout: 30 * time.Second}).Serve(m.ln)
	log.Printf("egress: farm proxy on 127.0.0.1:%d (namespace=%v)", egressPort.Load(), egressNS >= 0)
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
	fmt.Fprintf(w, "omnirush: %s is blocked in this environment (no internet access here; only package registries are reachable)\n", host)
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
			blocked(w, r.Host)
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
		blocked(w, r.Host)
		return
	}
	r.RequestURI = ""
	r.Header.Del("Proxy-Connection")
	r.Header.Del("Proxy-Authorization")
	res, err := direct.RoundTrip(r)
	if err != nil {
		http.Error(w, "omnirush: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer res.Body.Close()
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
