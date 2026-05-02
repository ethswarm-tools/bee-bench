package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"runtime"
	"sort"
	"time"
)

type CaseResult struct {
	Case            string         `json:"case"`
	Param           ParamEntry     `json:"param"`
	ItersMs         []float64      `json:"iters_ms"`
	MedianMs        float64        `json:"median_ms"`
	MinMs           float64        `json:"min_ms"`
	MaxMs           float64        `json:"max_ms"`
	MeanMs          float64        `json:"mean_ms"`
	ThroughputMBps  *float64       `json:"throughput_mbps,omitempty"`
	PeakRSSMB       float64        `json:"peak_rss_mb"`
	Notes           string         `json:"notes,omitempty"`
	Skipped         bool           `json:"skipped,omitempty"`
	SkipReason      string         `json:"skip_reason,omitempty"`
}

type RunResult struct {
	Runner          string       `json:"runner"`
	ClientVersion   string       `json:"client_version"`
	BeeVersion      string       `json:"bee_version"`
	BenchSpecHash   string       `json:"bench_spec_hash"`
	StartedAt       string       `json:"started_at"`
	Host            HostInfo     `json:"host"`
	BeeURL          string       `json:"bee_url"`
	BatchID         string       `json:"batch_id"`
	Iters           int          `json:"iters"`
	Results         []CaseResult `json:"results"`
}

type HostInfo struct {
	OS    string `json:"os"`
	Arch  string `json:"arch"`
	CPU   string `json:"cpu"`
	NumCPU int   `json:"num_cpu"`
}

// caseFn is the signature of a benchmark case implementation.
//   - returns durations in milliseconds for each iteration
//   - throughput-bytes is the total bytes processed per iter (for MB/s calc); 0 if N/A
//   - notes is a free-form string
type caseFn func(ctx context.Context, p ParamEntry) (ms []float64, bytesPerIter int64, notes string, err error)

// runCase orchestrates warmup + iters + RSS sampling around a caseFn.
func runCase(ctx context.Context, env *Env, c CaseSpec, p ParamEntry, fn caseFn) CaseResult {
	res := CaseResult{Case: c.ID, Param: p}

	// Warmup: invoke fn with reduced iteration count if possible. We expose a
	// "warmup" boolean in the param map so the case impl can skip RSS work etc.
	warmup := env.Spec.WarmupNet
	if c.Kind == "cpu" {
		warmup = env.Spec.WarmupCPU
	}
	if warmup > 0 {
		warmupParam := copyParam(p)
		warmupParam["warmup"] = true
		warmupParam["count_override"] = warmup // case impls may use this to scale down
		_, _, _, _ = fn(ctx, warmupParam)
	}

	// Timed run
	sampler := startRSSSampler(env.Spec.RSSSampleIntervalMs)
	ms, bytesPerIter, notes, err := fn(ctx, p)
	res.PeakRSSMB = roundTo(sampler.stopAndPeakMB(), 1)

	if err != nil {
		res.Notes = "ERR: " + err.Error()
		return res
	}
	if len(ms) == 0 {
		res.Skipped = true
		// If the impl signaled a SKIP via notes, surface that reason.
		if len(notes) > 6 && notes[:6] == "SKIP: " {
			res.SkipReason = notes[6:]
		} else if notes != "" {
			res.SkipReason = notes
		} else {
			res.SkipReason = "no iterations recorded"
		}
		return res
	}
	res.ItersMs = roundSlice(ms, 3)
	res.MinMs, res.MaxMs, res.MedianMs, res.MeanMs = stats(ms)
	if bytesPerIter > 0 {
		// throughput = bytes / median_seconds / 1MB
		mb := float64(bytesPerIter) / (1024 * 1024)
		t := mb / (res.MedianMs / 1000.0)
		t = roundTo(t, 2)
		res.ThroughputMBps = &t
	}
	res.Notes = notes
	return res
}

func copyParam(p ParamEntry) ParamEntry {
	out := make(ParamEntry, len(p))
	for k, v := range p {
		out[k] = v
	}
	return out
}

func stats(ms []float64) (min, max, median, mean float64) {
	if len(ms) == 0 {
		return
	}
	sorted := append([]float64(nil), ms...)
	sort.Float64s(sorted)
	min, max = sorted[0], sorted[len(sorted)-1]
	if len(sorted)%2 == 1 {
		median = sorted[len(sorted)/2]
	} else {
		median = (sorted[len(sorted)/2-1] + sorted[len(sorted)/2]) / 2
	}
	var sum float64
	for _, v := range ms {
		sum += v
	}
	mean = sum / float64(len(ms))
	return roundTo(min, 3), roundTo(max, 3), roundTo(median, 3), roundTo(mean, 3)
}

func roundTo(v float64, places int) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return v
	}
	mult := math.Pow(10, float64(places))
	return math.Round(v*mult) / mult
}

func roundSlice(in []float64, places int) []float64 {
	out := make([]float64, len(in))
	for i, v := range in {
		out[i] = roundTo(v, places)
	}
	return out
}

// time-this helper for case implementations.
func timeIt(fn func() error) (float64, error) {
	start := time.Now()
	err := fn()
	return float64(time.Since(start).Microseconds()) / 1000.0, err
}

func cooldown(sec int) {
	if sec > 0 {
		time.Sleep(time.Duration(sec) * time.Second)
	}
}

func writeResult(path string, r *RunResult) error {
	if err := os.MkdirAll(dirOf(path), 0o755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	return enc.Encode(r)
}

func dirOf(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[:i]
		}
	}
	return "."
}

func hostInfo() HostInfo {
	return HostInfo{
		OS:     runtime.GOOS,
		Arch:   runtime.GOARCH,
		CPU:    cpuModel(),
		NumCPU: runtime.NumCPU(),
	}
}

func cpuModel() string {
	raw, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return ""
	}
	for _, line := range splitLines(string(raw)) {
		if len(line) < 11 || line[:10] != "model name" {
			continue
		}
		// "model name\t: Intel(R) ..."
		for i := 0; i < len(line); i++ {
			if line[i] == ':' && i+2 < len(line) {
				return line[i+2:]
			}
		}
	}
	return ""
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

// debug helper — print to stderr without buffering
func logf(f string, args ...any) {
	fmt.Fprintf(os.Stderr, f+"\n", args...)
}
