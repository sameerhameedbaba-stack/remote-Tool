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
	"syscall"
	"time"

	"github.com/remote-support/backend/internal/audit"
	"github.com/remote-support/backend/internal/cache"
	"github.com/remote-support/backend/internal/config"
	"github.com/remote-support/backend/internal/httpapi"
	"github.com/remote-support/backend/internal/service"
	"github.com/remote-support/backend/internal/signal"
	"github.com/remote-support/backend/internal/store"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
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
	hub := signal.NewHub(log)
	svcs := service.New(cfg, st, ca, au, hub, log)
	srv := httpapi.NewServer(cfg, svcs, hub, au, st, ca, log)

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
