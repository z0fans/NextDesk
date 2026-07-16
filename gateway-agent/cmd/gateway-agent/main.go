package main

import (
	"context"
	"flag"
	"log"
	"os/signal"
	"syscall"

	"nextdesk/gateway-agent/internal/config"
	"nextdesk/gateway-agent/internal/runner"
)

func main() {
	configPath := flag.String("config", "/etc/connect-gateway-agent/config.json", "agent config path")
	dryRun := flag.Bool("dry-run", false, "render realm config without restarting systemd")
	once := flag.Bool("once", false, "run one poll cycle and exit")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	r, err := runner.New(cfg, *dryRun)
	if err != nil {
		log.Fatalf("create runner: %v", err)
	}
	if *once {
		if err := r.Once(); err != nil {
			log.Fatalf("run once: %v", err)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := r.Run(ctx); err != nil && err != context.Canceled {
		log.Fatalf("run: %v", err)
	}
}
