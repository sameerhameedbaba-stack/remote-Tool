// Command server is the Remote Support MVP backend: a REST API plus a
// WebSocket signaling hub. See docs/API.md and docs/ARCHITECTURE.md.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	ossignal "os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/remote-support/backend/internal/audit"
	"github.com/remote-support/backend/internal/cache"
	"github.com/remote-support/backend/internal/config"
	"github.com/remote-support/backend/internal/httpapi"
	"github.com/remote-support/backend/internal/rdhealth"
	"github.com/remote-support/backend/internal/service"
	"github.com/remote-support/backend/internal/signal"
	"github.com/remote-support/backend/internal/store"
)

func main() {
	// `server -healthcheck` performs an in-process liveness probe against the
	// running server's /healthz and exits 0/1. This lets the distroless image
	// (no shell, no curl) declare a Docker HEALTHCHECK that runs the binary.
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(healthcheck())
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

// healthcheck GETs the local /healthz and returns a process exit code.
func healthcheck() int {
	addr := os.Getenv("BACKEND_HTTP_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + addr + "/healthz")
	if err != nil {
		return 1
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusOK {
		return 0
	}
	return 1
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log.Info("config loaded", "app_env", envOrDefault(cfg.AppEnv, "prod"), "addr", cfg.HTTPAddr)

	// Bounded startup context for connecting to dependencies.
	startupCtx, cancelStartup := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelStartup()

	st, err := store.New(startupCtx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()

	if err := store.Migrate(startupCtx, st, log); err != nil {
		return err
	}

	ca, err := cache.New(startupCtx, cfg.RedisURL)
	if err != nil {
		return err
	}
	defer func() { _ = ca.Close() }()

	if err := service.SeedTechnician(startupCtx, st, cfg, log); err != nil {
		return err
	}

	au := audit.New(st, log)
	// Drain best-effort audit writes before the store closes (defers run LIFO).
	defer au.Close()
	hub := signal.NewHub(log)
	svcs := service.New(cfg, st, ca, au, hub, log)

	// Watch the RustDesk connection ports in the background so a technician's
	// "it failed at 14:32" can be checked against what the engine was doing at
	// 14:32. Independent of the request path: it never blocks a request and its
	// state is never consulted by /healthz or /readyz.
	prober := rdhealth.New(cfg.RustDeskServerID, cfg.RustDeskAPIURL, rdhealth.IntervalFromEnv(), log)
	proberCtx, stopProber := context.WithCancel(context.Background())
	defer stopProber()
	go prober.Run(proberCtx)

	srv := httpapi.NewServer(cfg, svcs, hub, au, st, ca, prober, log)

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 10 * time.Second,
		// No write timeout: WebSocket signaling connections are long-lived.
	}

	// Graceful shutdown on SIGINT/SIGTERM.
	ctx, stop := ossignal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
	go func() {
		log.Info("http server listening", "addr", cfg.HTTPAddr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
		log.Info("shutdown signal received")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "err", err)
		return err
	}
	log.Info("shutdown complete")
	return nil
}

func envOrDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
