package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	bee "github.com/ethswarm-tools/bee-go"
	"github.com/ethswarm-tools/bee-go/pkg/swarm"
)

const runnerName = "go"

type Env struct {
	BeeURL   string
	BatchID  swarm.BatchID
	HasBatch bool
	Spec     *BenchSpec
	SpecHash string
	Client   *bee.Client
	Fixtures *Fixtures
	OutPath  string
}

type Fixtures struct {
	bySize map[int][]byte
}

func (f *Fixtures) Get(sizeMB int) ([]byte, bool) {
	b, ok := f.bySize[sizeMB]
	return b, ok
}

func loadFixtures(dir string, spec *BenchSpec) (*Fixtures, error) {
	f := &Fixtures{bySize: map[int][]byte{}}
	for _, mb := range spec.SizesMB {
		path := filepath.Join(dir, fmt.Sprintf("%dmb.bin", mb))
		b, err := os.ReadFile(path)
		if err != nil {
			logf("warn: fixture %s missing — skipping that size", path)
			continue
		}
		f.bySize[mb] = b
	}
	if largeEnabled() && spec.LargeSizeMB > 0 {
		path := filepath.Join(dir, fmt.Sprintf("%dmb.bin", spec.LargeSizeMB))
		if b, err := os.ReadFile(path); err == nil {
			f.bySize[spec.LargeSizeMB] = b
		} else {
			logf("warn: large fixture %s missing — skipping", path)
		}
	}
	return f, nil
}

func largeEnabled() bool { return os.Getenv("BENCH_LARGE") == "1" }

func main() {
	repoRoot, err := findRepoRoot()
	if err != nil {
		fail("find repo root: %v", err)
	}

	specPath := filepath.Join(repoRoot, "bench-spec.json")
	spec, hash, err := loadSpec(specPath)
	if err != nil {
		fail("load spec: %v", err)
	}

	beeURL := envOr("BEE_URL", "http://localhost:1633")
	batchHex := os.Getenv("BEE_BATCH_ID")
	var batchID swarm.BatchID
	hasBatch := batchHex != ""
	if hasBatch {
		batchID, err = swarm.BatchIDFromHex(batchHex)
		if err != nil {
			fail("parse BEE_BATCH_ID: %v", err)
		}
	} else {
		logf("warn: BEE_BATCH_ID not set — net.* cases will be skipped")
	}

	client, err := bee.NewClient(beeURL)
	if err != nil {
		fail("bee.NewClient: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()

	beeVer := "unknown"
	if v, err := client.Debug.GetVersions(ctx); err == nil {
		beeVer = v.BeeVersion
	}

	fixDir := filepath.Join(repoRoot, "fixtures")
	fixtures, err := loadFixtures(fixDir, spec)
	if err != nil {
		fail("load fixtures: %v", err)
	}

	// Build the result skeleton
	ts := time.Now().UTC().Format(time.RFC3339)
	outPath := filepath.Join(repoRoot, "results",
		fmt.Sprintf("%s-%s.json", runnerName, time.Now().UTC().Format("20060102T150405Z")))
	res := &RunResult{
		Runner:        runnerName,
		ClientVersion: "bee-go (replace ../../bee-go)",
		BeeVersion:    beeVer,
		BenchSpecHash: hash,
		StartedAt:     ts,
		Host:          hostInfo(),
		BeeURL:        beeURL,
		BatchID:       batchHex,
		Iters:         spec.Iters,
		Results:       []CaseResult{},
	}

	env := &Env{
		BeeURL:   beeURL,
		BatchID:  batchID,
		HasBatch: hasBatch,
		Spec:     spec,
		SpecHash: hash,
		Client:   client,
		Fixtures: fixtures,
		OutPath:  outPath,
	}

	// Iterate cases serially. Within each case, iterate parameter sets serially.
	for i, c := range spec.Cases {
		if !c.runnerInSubset(runnerName) {
			logf("[%d/%d] skip %s (runner_subset excludes go)", i+1, len(spec.Cases), c.ID)
			continue
		}
		// Skip net.* cases up front when there's no usable batch.
		if c.Kind == "net" && !env.HasBatch {
			r := CaseResult{Case: c.ID, Skipped: true, SkipReason: "BEE_BATCH_ID not set"}
			res.Results = append(res.Results, r)
			logf("[%d/%d] skip %s (no BEE_BATCH_ID)", i+1, len(spec.Cases), c.ID)
			continue
		}
		fn := dispatchCase(c.ID, env)
		params := spec.resolveParams(c)
		for _, p := range params {
			pCopy := copyParam(p)
			// Skip large-only params unless BENCH_LARGE=1
			if isLargeParam(pCopy) && !largeEnabled() {
				continue
			}
			label := paramLabel(pCopy)
			logf("[%d/%d] %s %s ...", i+1, len(spec.Cases), c.ID, label)
			r := runCase(ctx, env, c, pCopy, fn)
			res.Results = append(res.Results, r)
			logRowSummary(c.ID, label, r)
		}
		cooldown(spec.CooldownSec)
	}

	if err := writeResult(outPath, res); err != nil {
		fail("write result: %v", err)
	}
	logf("\nwrote %s", outPath)
}

func isLargeParam(p ParamEntry) bool {
	if v, ok := p["large"].(bool); ok && v {
		return true
	}
	if v, ok := p["size_mb"].(float64); ok && int(v) >= 1024 {
		return true
	}
	if v, ok := p["size_mb"].(int); ok && v >= 1024 {
		return true
	}
	return false
}

func paramLabel(p ParamEntry) string {
	if len(p) == 0 {
		return ""
	}
	if v, ok := p["size_mb"]; ok {
		return fmt.Sprintf("size_mb=%v", v)
	}
	if v, ok := p["count"]; ok {
		return fmt.Sprintf("count=%v", v)
	}
	if v, ok := p["files"]; ok {
		return fmt.Sprintf("files=%v", v)
	}
	return ""
}

func logRowSummary(id, label string, r CaseResult) {
	if r.Skipped {
		logf("  → SKIP: %s", r.SkipReason)
		return
	}
	if r.Notes != "" && len(r.ItersMs) == 0 {
		logf("  → %s", r.Notes)
		return
	}
	tp := ""
	if r.ThroughputMBps != nil {
		tp = fmt.Sprintf(" (%.2f MB/s)", *r.ThroughputMBps)
	}
	logf("  → median %.2fms (min %.2f, max %.2f)%s rss=%.1fMB",
		r.MedianMs, r.MinMs, r.MaxMs, tp, r.PeakRSSMB)
}

func envOr(k, dflt string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return dflt
}

func envInt(k string, dflt int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return dflt
}

func fail(f string, args ...any) {
	fmt.Fprintf(os.Stderr, "runner-go: "+f+"\n", args...)
	os.Exit(1)
}

// findRepoRoot walks up from CWD looking for bench-spec.json. The runner
// can be invoked from runner-go/ or from the bee-bench/ root.
func findRepoRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	dir := cwd
	for i := 0; i < 6; i++ {
		if _, err := os.Stat(filepath.Join(dir, "bench-spec.json")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("bench-spec.json not found at or above %s", cwd)
}
