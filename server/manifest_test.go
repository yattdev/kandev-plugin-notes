// Package main tests, continued. This file guards the plugin's identity and
// privilege surface against drift: five files (manifest.yaml, go.mod,
// Makefile, ui/bundle.js, README.md) each carry the plugin id or version
// independently, and manifest.yaml's capabilities block is the whole
// privilege grant this plugin runs with. A rename or a version bump that
// only touches some of them should fail here, not at packaging or install
// time.
package main

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

const repoRoot = ".."

type manifestYAML struct {
	ID           string         `yaml:"id"`
	Version      string         `yaml:"version"`
	Capabilities map[string]any `yaml:"capabilities"`
	Webhooks     []any          `yaml:"webhooks"`
	ConfigSchema map[string]any `yaml:"config_schema"`
	UI           struct {
		Bundle string `yaml:"bundle"`
	} `yaml:"ui"`
	Runtime struct {
		Executables map[string]string `yaml:"executables"`
	} `yaml:"runtime"`
}

func loadManifest(t *testing.T) manifestYAML {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(repoRoot, "manifest.yaml"))
	require.NoError(t, err)
	var m manifestYAML
	require.NoError(t, yaml.Unmarshal(data, &m))
	return m
}

func readFile(t *testing.T, relPath string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(repoRoot, relPath))
	require.NoError(t, err)
	return string(data)
}

// mustMatch runs re against content and requires exactly one capture group.
func mustMatch(t *testing.T, re *regexp.Regexp, content, what string) string {
	t.Helper()
	m := re.FindStringSubmatch(content)
	require.Lenf(t, m, 2, "could not find %s", what)
	return m[1]
}

func goModModule(t *testing.T) string {
	t.Helper()
	return mustMatch(t, regexp.MustCompile(`(?m)^module (\S+)$`), readFile(t, "go.mod"), "go.mod module line")
}

func makefileBinID(t *testing.T) string {
	t.Helper()
	return mustMatch(t, regexp.MustCompile(`(?m)^BIN := bin/(\S+)$`), readFile(t, "Makefile"), "Makefile BIN")
}

func makefilePkgOutID(t *testing.T) string {
	t.Helper()
	return mustMatch(
		t,
		regexp.MustCompile(`(?m)^PKG_OUT := (\S+)-\$\(VERSION\)\.tar\.gz$`),
		readFile(t, "Makefile"),
		"Makefile PKG_OUT",
	)
}

func makefileVersion(t *testing.T) string {
	t.Helper()
	return mustMatch(t, regexp.MustCompile(`(?m)^VERSION := (\S+)$`), readFile(t, "Makefile"), "Makefile VERSION")
}

func bundleRegistrationID(t *testing.T) string {
	t.Helper()
	return mustMatch(
		t,
		regexp.MustCompile(`window\.registerKandevPlugin\(\s*"([^"]+)"`),
		readFile(t, "ui/bundle.js"),
		"ui/bundle.js registerKandevPlugin id",
	)
}

func TestManifestIdentity_MatchesGoModModule(t *testing.T) {
	m := loadManifest(t)
	require.Equal(t, m.ID, goModModule(t))
}

func TestManifestIdentity_MatchesMakefileBinAndPkgOut(t *testing.T) {
	m := loadManifest(t)
	require.Equal(t, m.ID, makefileBinID(t))
	require.Equal(t, m.ID, makefilePkgOutID(t))
}

func TestManifestIdentity_MatchesBundleRegistrationID(t *testing.T) {
	m := loadManifest(t)
	require.Equal(t, m.ID, bundleRegistrationID(t))
}

func TestManifestVersion_MatchesMakefileVersion(t *testing.T) {
	m := loadManifest(t)
	require.Equal(t, m.Version, makefileVersion(t))
}

func TestManifestCapabilities_UserStateAndAgentInvoke(t *testing.T) {
	m := loadManifest(t)
	require.Equal(t, map[string]any{"user_state": true, "agent_invoke": true}, m.Capabilities)
}

func TestManifest_DeclaresEnhanceWebhookAndUtilityAgentConfig(t *testing.T) {
	m := loadManifest(t)
	require.Len(t, m.Webhooks, 1)
	webhook, ok := m.Webhooks[0].(map[string]any)
	require.True(t, ok, "webhooks[0] should decode as a map")
	require.Equal(t, "enhance", webhook["key"])
	require.Equal(t, "POST", webhook["method"])

	require.NotEmpty(t, m.ConfigSchema)
	properties, ok := m.ConfigSchema["properties"].(map[string]any)
	require.True(t, ok, "config_schema.properties should decode as a map")
	utilityAgent, ok := properties["utility_agent"].(map[string]any)
	require.True(t, ok, "config_schema.properties.utility_agent should decode as a map")
	require.Equal(t, "string", utilityAgent["type"])
	require.Equal(t, "utility-agent", utilityAgent["format"])
}

func TestManifestUI_BundlePathHasLeadingSlash(t *testing.T) {
	m := loadManifest(t)
	require.Equal(t, "/ui/bundle.js", m.UI.Bundle)
}

func TestManifestRuntime_ExecutablesFollowNamingConvention(t *testing.T) {
	m := loadManifest(t)
	require.NotEmpty(t, m.Runtime.Executables)
	for platform, path := range m.Runtime.Executables {
		goos, goarch, ok := splitPlatform(platform)
		require.Truef(t, ok, "unexpected platform key %q", platform)
		want := "server/plugin-" + goos + "-" + goarch
		if goos == "windows" {
			want += ".exe"
		}
		require.Equalf(t, want, path, "executable path for platform %q", platform)
	}
}

func splitPlatform(platform string) (goos, goarch string, ok bool) {
	m := regexp.MustCompile(`^([a-z0-9]+)-([a-z0-9]+)$`).FindStringSubmatch(platform)
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}
