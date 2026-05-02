package main

import (
	"context"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// readVmRSSKB reads the resident-set-size in kilobytes from /proc/self/status.
// Returns 0 on any error (Linux-only; other OS get 0 and the bench reports 0).
func readVmRSSKB() uint64 {
	raw, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0
		}
		v, _ := strconv.ParseUint(fields[1], 10, 64)
		return v
	}
	return 0
}

// rssSampler polls VmRSS every interval and tracks the peak. Stop with cancel.
type rssSampler struct {
	peakKB atomic.Uint64
	stop   context.CancelFunc
	done   chan struct{}
}

func startRSSSampler(intervalMs int) *rssSampler {
	if intervalMs <= 0 {
		intervalMs = 100
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &rssSampler{stop: cancel, done: make(chan struct{})}
	// take an initial sample so the peak is never 0 even for very short cases
	s.update(readVmRSSKB())
	go func() {
		defer close(s.done)
		t := time.NewTicker(time.Duration(intervalMs) * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.update(readVmRSSKB())
			}
		}
	}()
	return s
}

func (s *rssSampler) update(kb uint64) {
	for {
		cur := s.peakKB.Load()
		if kb <= cur {
			return
		}
		if s.peakKB.CompareAndSwap(cur, kb) {
			return
		}
	}
}

// stopAndPeakMB stops the sampler and returns peak RSS in megabytes.
func (s *rssSampler) stopAndPeakMB() float64 {
	s.stop()
	<-s.done
	// take one more sample after stop to catch any final allocation
	s.update(readVmRSSKB())
	return float64(s.peakKB.Load()) / 1024.0
}
