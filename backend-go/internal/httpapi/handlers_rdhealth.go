package httpapi

import (
	"net/http"

	"github.com/remote-support/backend/internal/rdhealth"
)

// handleRustDeskHealth returns the rolling history of the RustDesk connection
// ports. Admin-only: it exposes the engine's host and its failure history, which
// is operator information, not tenant information.
//
// It cannot fail. When the prober is absent or unconfigured the response is a
// well-formed report with enabled=false, so the console renders a "not watching"
// hint rather than an error — same soft-degrade contract as the fleet endpoint.
func (s *Server) handleRustDeskHealth(w http.ResponseWriter, r *http.Request) {
	if s.prober == nil {
		writeJSON(w, http.StatusOK, rdhealth.Report{
			Targets: []rdhealth.Target{},
			Outages: []rdhealth.Outage{},
			Buckets: []rdhealth.Bucket{},
		})
		return
	}
	writeJSON(w, http.StatusOK, s.prober.Report())
}
