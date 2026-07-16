package realm

import (
	"fmt"
	"path/filepath"
)

type Profile struct {
	Name          string
	ConfigDir     string
	RulesDir      string
	InstancesDir  string
	ServicePrefix string
	DryRun        bool
}

func NewProfile(name, dryRunRoot string, dryRun bool) (Profile, error) {
	if name == "" {
		name = "cg"
	}
	if name == "pf" {
		return Profile{}, fmt.Errorf("profile pf is reserved; use cg for ConnectGateway")
	}

	configDir := "/etc/realm-" + name
	if dryRun {
		configDir = filepath.Join(dryRunRoot, "realm-"+name)
	}
	return Profile{
		Name:          name,
		ConfigDir:     configDir,
		RulesDir:      filepath.Join(configDir, "rules"),
		InstancesDir:  filepath.Join(configDir, "instances"),
		ServicePrefix: "realm-" + name + "@",
		DryRun:        dryRun,
	}, nil
}
