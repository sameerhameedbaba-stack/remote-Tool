package httpapi

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/remote-support/backend/internal/service"
)

// safeUsername limits which per-technician installer filenames we will look up,
// so a resolved username can never escape the client directory.
var safeUsername = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,62})$`)

type connectResolveResponse struct {
	OK         bool   `json:"ok"`
	Technician string `json:"technician,omitempty"`
}

// handleConnectResolve validates a support code (without consuming it) so the
// connect page can reject bad codes before offering a download. Public + rate
// limited to blunt code enumeration.
func (s *Server) handleConnectResolve(w http.ResponseWriter, r *http.Request) {
	if !s.joinLimiter.Allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many attempts")
		return
	}
	code := r.URL.Query().Get("code")
	target, err := s.svcs.Attended.ResolveCode(r.Context(), code)
	if err != nil {
		// Map both invalid and unknown/expired to a single 404 so a caller can't
		// distinguish "never existed" from "expired" (no code enumeration signal).
		if errors.Is(err, service.ErrInvalid) || errors.Is(err, service.ErrNotFound) {
			writeError(w, http.StatusNotFound, "invalid_code", "that code is invalid or has expired")
			return
		}
		writeServiceError(w, s.log, err)
		return
	}
	writeJSON(w, http.StatusOK, connectResolveResponse{OK: true, Technician: target.Username})
}

// handleConnectDownload streams the branded client for a valid code. It serves
// the code's technician's installer (<username>.exe) when present, else the
// generic remote-agent.exe. Public + rate limited; re-validates the code.
func (s *Server) handleConnectDownload(w http.ResponseWriter, r *http.Request) {
	if !s.joinLimiter.Allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many attempts")
		return
	}
	code := r.URL.Query().Get("code")
	target, err := s.svcs.Attended.ResolveCode(r.Context(), code)
	if err != nil {
		if errors.Is(err, service.ErrInvalid) || errors.Is(err, service.ErrNotFound) {
			writeError(w, http.StatusNotFound, "invalid_code", "that code is invalid or has expired")
			return
		}
		writeServiceError(w, s.log, err)
		return
	}

	path, ok := s.resolveClientFile(target.Username)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "client_unavailable",
			"the client installer is not available yet — please contact your technician")
		return
	}
	s.serveClientFile(w, r, path, "Tiefixy-Support.exe")
}

// handleTechnicianApp serves the branded desktop app technicians install to
// CONTROL remote PCs. It serves console.exe (or technician.exe) when present,
// else the generic client — the same RustDesk client also connects outward.
// Public: the controlling app is not sensitive on its own (a connection still
// needs a valid device ID + permanent password).
func (s *Server) handleTechnicianApp(w http.ResponseWriter, r *http.Request) {
	dir := s.cfg.ConnectClientDir
	var path string
	for _, name := range []string{"console.exe", "technician.exe", "remote-agent.exe"} {
		if dir == "" {
			break
		}
		if p := filepath.Join(dir, name); fileExists(p) {
			path = p
			break
		}
	}
	if path == "" {
		writeError(w, http.StatusServiceUnavailable, "client_unavailable",
			"the technician app is not available yet")
		return
	}
	s.serveClientFile(w, r, path, "Tiefixy-Console.exe")
}

// serveClientFile streams an on-disk installer as a download.
func (s *Server) serveClientFile(w http.ResponseWriter, r *http.Request, path, downloadName string) {
	f, err := os.Open(path)
	if err != nil {
		s.log.Warn("client download open failed", "path", path, "err", err)
		writeError(w, http.StatusServiceUnavailable, "client_unavailable", "the installer is not available yet")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		writeError(w, http.StatusServiceUnavailable, "client_unavailable", "the installer is not available yet")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+downloadName+`"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// http.ServeContent adds Content-Length + range support and streams the file.
	http.ServeContent(w, r, downloadName, info.ModTime(), f)
}

// resolveClientFile returns the installer path for a technician username,
// falling back to the generic client. It never returns a path outside the
// configured client dir.
func (s *Server) resolveClientFile(username string) (string, bool) {
	dir := s.cfg.ConnectClientDir
	if dir == "" {
		return "", false
	}
	if u := strings.ToLower(strings.TrimSpace(username)); safeUsername.MatchString(u) {
		if p := filepath.Join(dir, u+".exe"); fileExists(p) {
			return p, true
		}
	}
	if p := filepath.Join(dir, "remote-agent.exe"); fileExists(p) {
		return p, true
	}
	return "", false
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}
