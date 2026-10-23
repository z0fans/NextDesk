package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os/signal"
	"syscall"

	"nextdesk/gateway-agent/internal/api"
	"nextdesk/gateway-agent/internal/config"
	"nextdesk/gateway-agent/internal/runner"
)

func main() {
	configPath := flag.String("config", "/etc/connect-gateway-agent/config.json", "agent config path")
	dryRun := flag.Bool("dry-run", false, "render realm config without restarting systemd")
	once := flag.Bool("once", false, "run one poll cycle and exit")
	version := flag.Bool("version", false, "print agent version and exit")
	flag.Parse()
	if *version {
		fmt.Println(api.Version)
		return
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	r, err := runner.New(cfg, *dryRun)
	if err != nil {
		log.Fatalf("create runner: %v", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if *once {
		if err := r.Once(ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Fatalf("run once: %v", err)
		}
		return
	}
	if err := r.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatalf("run: %v", err)
	}
}
