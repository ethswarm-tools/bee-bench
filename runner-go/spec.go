package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
)

type BenchSpec struct {
	Version              string                  `json:"version"`
	Iters                int                     `json:"iters"`
	WarmupNet            int                     `json:"warmup_net"`
	WarmupCPU            int                     `json:"warmup_cpu"`
	CooldownSec          int                     `json:"cooldown_between_cases_sec"`
	SizesMB              []int                   `json:"sizes_mb"`
	LargeSizeMB          int                     `json:"large_size_mb"`
	RSSSampleIntervalMs  int                     `json:"rss_sample_interval_ms"`
	Cases                []CaseSpec              `json:"cases"`
	ParamSets            map[string][]ParamEntry `json:"param_sets"`
}

type CaseSpec struct {
	ID            string       `json:"id"`
	Kind          string       `json:"kind"`           // "cpu" | "net"
	Params        []ParamEntry `json:"params,omitempty"`
	ParamsFrom    string       `json:"params_from,omitempty"`
	RunnerSubset  []string     `json:"runner_subset,omitempty"`
	Doc           string       `json:"doc,omitempty"`
}

type ParamEntry map[string]any

func loadSpec(path string) (*BenchSpec, string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, "", fmt.Errorf("read %s: %w", path, err)
	}
	sum := sha256.Sum256(raw)
	hash := "sha256:" + hex.EncodeToString(sum[:])

	var s BenchSpec
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, "", fmt.Errorf("parse %s: %w", path, err)
	}
	return &s, hash, nil
}

// resolveParams returns the effective parameter list for a case, expanding
// params_from references against the spec's param_sets.
func (s *BenchSpec) resolveParams(c CaseSpec) []ParamEntry {
	if len(c.Params) > 0 {
		return c.Params
	}
	if c.ParamsFrom != "" {
		if entries, ok := s.ParamSets[c.ParamsFrom]; ok {
			return entries
		}
	}
	return []ParamEntry{{}}
}

// runnerInSubset reports whether this runner ("go") should execute the case.
// Empty subset = all runners.
func (c CaseSpec) runnerInSubset(runner string) bool {
	if len(c.RunnerSubset) == 0 {
		return true
	}
	for _, r := range c.RunnerSubset {
		if r == runner {
			return true
		}
	}
	return false
}
