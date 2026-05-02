package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	nethttp "net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
	bee "github.com/ethswarm-tools/bee-go"
	"github.com/ethswarm-tools/bee-go/pkg/api"
	"github.com/ethswarm-tools/bee-go/pkg/file"
	"github.com/ethswarm-tools/bee-go/pkg/manifest"
	"github.com/ethswarm-tools/bee-go/pkg/swarm"
)

// dispatchCase routes a case ID to its implementation. Cases not yet
// implemented return a "not implemented" skip.
func dispatchCase(id string, env *Env) caseFn {
	switch id {
	case "cpu.keccak.chunk-hash":
		return caseKeccakChunkHash
	case "cpu.keccak.parallel":
		return caseKeccakParallel
	case "cpu.keccak.bulk":
		return caseKeccakBulk(env.Fixtures)
	case "cpu.bmt.file-root":
		return caseBmtFileRoot(env.Fixtures)
	case "cpu.bmt.encrypted-file-root":
		return notImplemented("no offline encryption-aware chunker API in bee-go")
	case "cpu.ecdsa.sign-1000":
		return caseEcdsaSign
	case "cpu.ecdsa.verify-1000":
		return caseEcdsaVerify
	case "cpu.manifest.hash-50files":
		return caseManifestHash50
	case "cpu.manifest.lookup-large":
		return caseManifestLookupLarge
	case "net.stamps.list":
		return caseStampsList(env.Client)
	case "net.stamps.concurrent":
		return caseStampsConcurrent(env.Client)
	case "cpu.identity.create":
		return caseIdentityCreate
	case "net.bytes.head":
		return caseBytesHead(env.Client, env.BatchID, env.BeeURL, env.Fixtures)
	case "net.bytes.download.range":
		return caseBytesDownloadRange(env.Client, env.BatchID, env.BeeURL, env.Fixtures)
	case "net.bzz.upload":
		return caseBzzUpload(env.Client, env.BatchID, env.Fixtures)
	case "net.bzz.upload.encrypted":
		return caseBzzUploadEncrypted(env.Client, env.BatchID, env.Fixtures)
	case "net.bzz.upload-from-disk":
		return caseBzzUploadFromDisk(env.Client, env.BatchID, env.Spec)
	case "net.bytes.upload":
		return caseBytesUpload(env.Client, env.BatchID, env.Fixtures)
	case "net.bzz.download":
		return caseBzzDownload(env.Client, env.BatchID, env.Fixtures)
	case "net.chunks.upload":
		return caseChunksUpload(env.Client, env.BatchID)
	case "net.stream-dir.upload":
		return caseStreamDirUpload(env.Client, env.BatchID)
	case "net.soc.upload":
		return caseSocUpload(env.Client, env.BatchID)
	case "net.pin.add-list":
		return casePinAddList(env.Client, env.BatchID)
	case "net.tags.upload-with-tag":
		return caseTagsUploadWithTag(env.Client, env.BatchID, env.Fixtures)
	case "net.feed.write-read.fresh":
		return caseFeedFresh(env.Client, env.BatchID)
	case "net.feed.write-read.warm":
		return caseFeedWarm(env.Client, env.BatchID)
	default:
		return notImplemented("not implemented yet")
	}
}

func notImplemented(reason string) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		// Encode skip via empty ms + the notes field. The runner's runCase
		// wrapper turns empty ms into Skipped=true, but we want a clear reason.
		return nil, 0, "SKIP: " + reason, nil
	}
}

// ---------- cpu.keccak.chunk-hash ----------
//
// Hash N × full-chunk inputs (8-byte span + 4096-byte payload) via the
// client's BMT chunk-address path. Each iteration runs the inner loop once.
func caseKeccakChunkHash(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
	count := intParam(p, "count", 10000)
	chunkBytes := intParam(p, "chunk_bytes", 4096)

	// Pre-build the buffer: span (8) + payload (chunkBytes). Random payload.
	buf := make([]byte, 8+chunkBytes)
	binary.LittleEndian.PutUint64(buf[:8], uint64(chunkBytes))
	if _, err := rand.Read(buf[8:]); err != nil {
		return nil, 0, "", err
	}

	if isWarmup(p) {
		// scale down warmup
		count = max(count/100, 100)
	}

	iters := defaultIters(p)
	out := make([]float64, 0, iters)
	for i := 0; i < iters; i++ {
		ms, err := timeIt(func() error {
			for j := 0; j < count; j++ {
				if _, err := swarm.CalculateChunkAddress(buf); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return nil, 0, "", err
		}
		out = append(out, ms)
	}
	totalBytes := int64(count) * int64(chunkBytes)
	return out, totalBytes, fmt.Sprintf("count=%d chunk_bytes=%d", count, chunkBytes), nil
}

// ---------- cpu.identity.create ----------
//
// Generate N fresh secp256k1 identities: random 32 bytes → PrivateKey →
// derive public key → derive 20-byte Ethereum address.
func caseIdentityCreate(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
	count := intParam(p, "count", 1000)
	if isWarmup(p) {
		count = max(count/100, 100)
	}
	iters := defaultIters(p)
	out := make([]float64, 0, iters)
	var b [32]byte
	for i := 0; i < iters; i++ {
		ms, err := timeIt(func() error {
			for j := 0; j < count; j++ {
				_, _ = rand.Read(b[:])
				k, err := swarm.NewPrivateKey(b[:])
				if err != nil {
					continue
				}
				_ = k.PublicKey().Address()
			}
			return nil
		})
		if err != nil {
			return nil, 0, "", err
		}
		out = append(out, ms)
	}
	return out, 0, fmt.Sprintf("count=%d", count), nil
}

// ---------- cpu.keccak.parallel ----------
//
// Distribute count BMT chunk hashes across W = runtime.NumCPU() goroutines.
// Each goroutine generates + hashes its own slice (no shared state). Time =
// wall clock to all goroutines complete.
func caseKeccakParallel(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
	count := intParam(p, "count", 10000)
	chunkBytes := intParam(p, "chunk_bytes", 4096)
	workers := runtime.NumCPU()

	if isWarmup(p) {
		count = max(count/100, 100)
	}
	iters := defaultIters(p)
	out := make([]float64, 0, iters)
	perWorker := (count + workers - 1) / workers

	for i := 0; i < iters; i++ {
		ms, err := timeIt(func() error {
			var wg sync.WaitGroup
			for w := 0; w < workers; w++ {
				start := w * perWorker
				if start >= count {
					break
				}
				end := start + perWorker
				if end > count {
					end = count
				}
				n := end - start
				wg.Add(1)
				go func() {
					defer wg.Done()
					buf := make([]byte, 8+chunkBytes)
					binary.LittleEndian.PutUint64(buf[:8], uint64(chunkBytes))
					_, _ = rand.Read(buf[8:])
					for j := 0; j < n; j++ {
						_, _ = swarm.CalculateChunkAddress(buf)
					}
				}()
			}
			wg.Wait()
			return nil
		})
		if err != nil {
			return nil, 0, "", err
		}
		out = append(out, ms)
	}
	totalBytes := int64(count) * int64(chunkBytes)
	return out, totalBytes, fmt.Sprintf("count=%d workers=%d", count, workers), nil
}

// ---------- cpu.keccak.bulk ----------
//
// Hash one large buffer in a single Keccak256 call. Tests throughput rather
// than per-call overhead.
func caseKeccakBulk(fix *Fixtures) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		sizeMB := intParam(p, "size_mb", 100)
		buf, ok := fix.Get(sizeMB)
		if !ok {
			return nil, 0, "", fmt.Errorf("fixture %dmb.bin missing%s", sizeMB, largeHint(sizeMB))
		}
		if isWarmup(p) {
			_ = swarm.Keccak256(buf)
			return nil, 0, "", nil
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := timeIt(func() error {
				_ = swarm.Keccak256(buf)
				return nil
			})
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, int64(len(buf)), "", nil
	}
}

// ---------- cpu.bmt.file-root ----------
//
// Compute the BMT/Mantaray root for a buffer via the streaming file chunker,
// no upload. This is the colleague's chunking-perf hypothesis test.
func caseBmtFileRoot(fix *Fixtures) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		sizeMB := intParam(p, "size_mb", 0)
		if sizeMB == 0 {
			return nil, 0, "", fmt.Errorf("missing size_mb")
		}
		buf, ok := fix.Get(sizeMB)
		if !ok {
			return nil, 0, "", fmt.Errorf("fixture %dmb.bin missing%s", sizeMB, largeHint(sizeMB))
		}
		runOne := func() error {
			c := swarm.NewFileChunker(nil)
			if _, err := c.Write(buf); err != nil {
				return err
			}
			_, err := c.Finalize()
			return err
		}
		if isWarmup(p) {
			return nil, 0, "", runOne()
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := timeIt(runOne)
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, int64(len(buf)), "", nil
	}
}

// ---------- cpu.ecdsa.sign-1000 ----------
//
// Sign N 32-byte digests with the eth-envelope scheme (matches bee-js / bee-rs).
func caseEcdsaSign(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
	count := intParam(p, "count", 1000)
	// Deterministic test key — we're only timing sign, not the key.
	pk, err := swarm.PrivateKeyFromHex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")
	if err != nil {
		return nil, 0, "", err
	}
	digest := make([]byte, 32)
	if _, err := rand.Read(digest); err != nil {
		return nil, 0, "", err
	}
	if isWarmup(p) {
		count = max(count/10, 50)
	}
	iters := defaultIters(p)
	out := make([]float64, 0, iters)
	for i := 0; i < iters; i++ {
		ms, err := timeIt(func() error {
			for j := 0; j < count; j++ {
				if _, err := pk.Sign(digest); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return nil, 0, "", err
		}
		out = append(out, ms)
	}
	return out, 0, fmt.Sprintf("count=%d", count), nil
}

// ---------- cpu.manifest.hash-50files ----------
//
// Offline manifest root for N small files, no upload. Exercises Mantaray
// trie construction + leaf chunk hashing.
func caseManifestHash50(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
	files := intParam(p, "files", 50)
	fileBytes := intParam(p, "file_bytes", 1024)
	entries := make([]file.CollectionEntry, files)
	for i := range entries {
		data := make([]byte, fileBytes)
		if _, err := rand.Read(data); err != nil {
			return nil, 0, "", err
		}
		entries[i] = file.CollectionEntry{
			Path: fmt.Sprintf("file-%04d.bin", i),
			Data: data,
		}
	}
	runOne := func() error {
		_, err := file.HashCollectionEntries(entries)
		return err
	}
	if isWarmup(p) {
		return nil, 0, "", runOne()
	}
	iters := defaultIters(p)
	out := make([]float64, 0, iters)
	for i := 0; i < iters; i++ {
		ms, err := timeIt(runOne)
		if err != nil {
			return nil, 0, "", err
		}
		out = append(out, ms)
	}
	return out, int64(files * fileBytes), fmt.Sprintf("files=%d bytes_each=%d", files, fileBytes), nil
}

// ---------- net.stamps.list ----------
//
// One GET /stamps per iteration. Calibration / control case.
func caseStampsList(client *bee.Client) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		if isWarmup(p) {
			_, _ = client.Postage.GetPostageBatches(ctx)
			return nil, 0, "", nil
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := timeIt(func() error {
				_, err := client.Postage.GetPostageBatches(ctx)
				return err
			})
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, 0, "", nil
	}
}

// ---------- net.stamps.concurrent ----------
//
// Fire N parallel GET /stamps. Bee returns instantly; spread across runners
// is pure HTTP-client overhead — connection pool size, keepalive defaults,
// async dispatch cost. Per iter measures total burst time.
func caseStampsConcurrent(client *bee.Client) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		count := intParam(p, "count", 200)
		burst := func() error {
			errCh := make(chan error, count)
			var wg sync.WaitGroup
			wg.Add(count)
			for i := 0; i < count; i++ {
				go func() {
					defer wg.Done()
					_, err := client.Postage.GetPostageBatches(ctx)
					if err != nil {
						errCh <- err
					}
				}()
			}
			wg.Wait()
			close(errCh)
			for e := range errCh {
				return e
			}
			return nil
		}
		if isWarmup(p) {
			return nil, 0, "", burst()
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := timeIt(burst)
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, 0, fmt.Sprintf("count=%d", count), nil
	}
}

// ---------- net.bytes.head ----------
//
// Pre-upload via /bytes once, then time N HEAD calls (no body). Isolates
// HTTP-stack cost (pool + keepalive + header parse).
func caseBytesHead(client *bee.Client, batchID swarm.BatchID, beeURL string, fix *Fixtures) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		count := intParam(p, "count", 100)
		buf, ok := fix.Get(1)
		if !ok {
			return nil, 0, "", fmt.Errorf("fixture 1mb.bin missing")
		}
		salted := make([]byte, 8+len(buf))
		copy(salted[8:], buf)
		_, _ = rand.Read(salted[:8])
		up, err := client.File.UploadData(ctx, batchID, bytes.NewReader(salted), nil)
		if err != nil {
			return nil, 0, "", fmt.Errorf("pre-upload: %w", err)
		}
		url := fmt.Sprintf("%s/bytes/%s", beeURL, up.Reference)
		hc := &nethttp.Client{}
		burst := func() error {
			for i := 0; i < count; i++ {
				req, _ := nethttp.NewRequestWithContext(ctx, "HEAD", url, nil)
				resp, err := hc.Do(req)
				if err != nil {
					return err
				}
				_ = resp.Body.Close()
			}
			return nil
		}
		if isWarmup(p) {
			return nil, 0, "", burst()
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := timeIt(burst)
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, 0, fmt.Sprintf("count=%d", count), nil
	}
}

// ---------- net.bytes.download.range ----------
//
// Pre-upload 100MB via /bytes, then time N range GETs for a 1MB slice.
// Tests Range header support + streaming partial responses.
func caseBytesDownloadRange(client *bee.Client, batchID swarm.BatchID, beeURL string, fix *Fixtures) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		sliceMB := intParam(p, "slice_mb", 1)
		buf, ok := fix.Get(100)
		if !ok {
			return nil, 0, "", fmt.Errorf("fixture 100mb.bin missing")
		}
		salted := make([]byte, 8+len(buf))
		copy(salted[8:], buf)
		_, _ = rand.Read(salted[:8])
		up, err := client.File.UploadData(ctx, batchID, bytes.NewReader(salted), nil)
		if err != nil {
			return nil, 0, "", fmt.Errorf("pre-upload: %w", err)
		}
		url := fmt.Sprintf("%s/bytes/%s", beeURL, up.Reference)
		hc := &nethttp.Client{}
		sliceBytes := sliceMB * 1024 * 1024
		rangeHdr := fmt.Sprintf("bytes=0-%d", sliceBytes-1)
		drain := func() error {
			req, _ := nethttp.NewRequestWithContext(ctx, "GET", url, nil)
			req.Header.Set("Range", rangeHdr)
			resp, err := hc.Do(req)
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			_, err = io.Copy(io.Discard, resp.Body)
			return err
		}
		if isWarmup(p) {
			return nil, 0, "", drain()
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := timeIt(drain)
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, int64(sliceBytes), fmt.Sprintf("slice_mb=%d", sliceMB), nil
	}
}

// ---------- net.bzz.upload ----------
//
// POST /bzz (with manifest wrapping). Each iter prepends a fresh 8-byte salt
// to the in-memory fixture so the resulting reference is unique (no Bee
// dedup warm-cache effect).
func caseBzzUpload(client *bee.Client, batchID swarm.BatchID, fix *Fixtures) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		return runUploadFile(ctx, client, batchID, fix, p, nil)
	}
}

// ---------- net.bzz.upload.encrypted ----------
//
// POST /bzz with encrypt=true. The reference returned is 64 bytes (ref + key).
func caseBzzUploadEncrypted(client *bee.Client, batchID swarm.BatchID, fix *Fixtures) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		enc := true
		opts := &api.FileUploadOptions{UploadOptions: api.UploadOptions{Encrypt: &enc}}
		return runUploadFile(ctx, client, batchID, fix, p, opts)
	}
}

// runUploadFile is shared between net.bzz.upload and net.bzz.upload.encrypted.
func runUploadFile(
	ctx context.Context,
	client *bee.Client,
	batchID swarm.BatchID,
	fix *Fixtures,
	p ParamEntry,
	opts *api.FileUploadOptions,
) ([]float64, int64, string, error) {
	sizeMB := intParam(p, "size_mb", 0)
	if sizeMB == 0 {
		return nil, 0, "", fmt.Errorf("missing size_mb")
	}
	buf, ok := fix.Get(sizeMB)
	if !ok {
		return nil, 0, "",
			fmt.Errorf("fixture %dmb.bin missing — run scripts/gen-fixtures.sh%s",
				sizeMB, largeHint(sizeMB))
	}
	salted := make([]byte, 8+len(buf))
	copy(salted[8:], buf)

	if isWarmup(p) {
		_, _ = rand.Read(salted[:8])
		r := bytes.NewReader(salted)
		_, err := client.File.UploadFile(ctx, batchID, r, "bench.bin", "application/octet-stream", opts)
		return nil, 0, "", err
	}

	iters := defaultIters(p)
	out := make([]float64, 0, iters)
	for i := 0; i < iters; i++ {
		if _, err := rand.Read(salted[:8]); err != nil {
			return nil, 0, "", err
		}
		ms, err := timeIt(func() error {
			r := bytes.NewReader(salted)
			_, err := client.File.UploadFile(ctx, batchID, r, "bench.bin", "application/octet-stream", opts)
			return err
		})
		if err != nil {
			return nil, 0, "", err
		}
		out = append(out, ms)
	}
	return out, int64(len(salted)), "", nil
}

// ---------- net.bzz.upload-from-disk ----------
//
// Stream a 1GB file from disk via os.Open into POST /bzz. Tests genuine
// streaming (no in-memory buffering of the payload). bee-rs N/A.
func caseBzzUploadFromDisk(client *bee.Client, batchID swarm.BatchID, spec *BenchSpec) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		sizeMB := intParam(p, "size_mb", spec.LargeSizeMB)
		if sizeMB == 0 {
			return nil, 0, "", fmt.Errorf("missing size_mb")
		}
		repo, err := findRepoRoot()
		if err != nil {
			return nil, 0, "", err
		}
		path := filepath.Join(repo, "fixtures", fmt.Sprintf("%dmb.bin", sizeMB))
		if _, err := os.Stat(path); err != nil {
			return nil, 0, "", fmt.Errorf("fixture %s missing%s", path, largeHint(sizeMB))
		}

		runOne := func() (float64, error) {
			f, err := os.Open(path)
			if err != nil {
				return 0, err
			}
			defer f.Close()
			return timeIt(func() error {
				_, err := client.File.UploadFile(ctx, batchID, f, "bench.bin", "application/octet-stream", nil)
				return err
			})
		}

		if isWarmup(p) {
			_, _ = runOne()
			return nil, 0, "", nil
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := runOne()
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, int64(sizeMB) * 1024 * 1024, "", nil
	}
}

// ---------- net.bytes.upload ----------
//
// POST /bytes (raw, no manifest). Isolates manifest serialization cost.
func caseBytesUpload(client *bee.Client, batchID swarm.BatchID, fix *Fixtures) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		sizeMB := intParam(p, "size_mb", 0)
		if sizeMB == 0 {
			return nil, 0, "", fmt.Errorf("missing size_mb")
		}
		buf, ok := fix.Get(sizeMB)
		if !ok {
			return nil, 0, "", fmt.Errorf("fixture %dmb.bin missing", sizeMB)
		}
		salted := make([]byte, 8+len(buf))
		copy(salted[8:], buf)

		if isWarmup(p) {
			_, _ = rand.Read(salted[:8])
			_, err := client.File.UploadData(ctx, batchID, bytes.NewReader(salted), nil)
			return nil, 0, "", err
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			if _, err := rand.Read(salted[:8]); err != nil {
				return nil, 0, "", err
			}
			ms, err := timeIt(func() error {
				_, err := client.File.UploadData(ctx, batchID, bytes.NewReader(salted), nil)
				return err
			})
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, int64(len(salted)), "", nil
	}
}

// ---------- net.bzz.download ----------
//
// Pre-upload the fixture once via /bzz, then time GET /bzz/<ref> reads.
// Body is drained to io.Discard (no buffering of full response).
func caseBzzDownload(client *bee.Client, batchID swarm.BatchID, fix *Fixtures) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		sizeMB := intParam(p, "size_mb", 0)
		if sizeMB == 0 {
			return nil, 0, "", fmt.Errorf("missing size_mb")
		}
		buf, ok := fix.Get(sizeMB)
		if !ok {
			return nil, 0, "", fmt.Errorf("fixture %dmb.bin missing", sizeMB)
		}
		// Upload once, capture the reference.
		salted := make([]byte, 8+len(buf))
		copy(salted[8:], buf)
		_, _ = rand.Read(salted[:8])
		up, err := client.File.UploadFile(ctx, batchID, bytes.NewReader(salted), "bench.bin", "application/octet-stream", nil)
		if err != nil {
			return nil, 0, "", fmt.Errorf("pre-upload: %w", err)
		}
		ref := up.Reference

		runOne := func() error {
			rc, _, err := client.File.DownloadFile(ctx, ref, nil)
			if err != nil {
				return err
			}
			_, err = drainAndDiscard(rc)
			return err
		}
		if isWarmup(p) {
			return nil, 0, "", runOne()
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := timeIt(runOne)
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, int64(len(salted)), "", nil
	}
}

// ---------- net.chunks.upload ----------
//
// Build N pre-computed content-addressed chunks locally (CPU work outside
// the timed region) then time their upload via POST /chunks.
func caseChunksUpload(client *bee.Client, batchID swarm.BatchID) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		count := intParam(p, "count", 1000)
		if isWarmup(p) {
			count = max(count/10, 50)
		}
		// Pre-build chunks. Salt the first 8 bytes of each payload so addresses
		// are unique per run (no warm-cache).
		chunks := make([][]byte, count)
		nonce := make([]byte, 8)
		for i := range chunks {
			payload := make([]byte, 256) // small payloads — we're testing per-call cost
			binary.BigEndian.PutUint64(payload[:8], uint64(i))
			_, _ = rand.Read(nonce)
			copy(payload[8:16], nonce)
			c, err := swarm.MakeContentAddressedChunk(payload)
			if err != nil {
				return nil, 0, "", err
			}
			chunks[i] = c.Data()
		}
		runOne := func() error {
			for _, wire := range chunks {
				if _, err := client.File.UploadChunk(ctx, batchID, wire, nil); err != nil {
					return err
				}
			}
			return nil
		}
		if isWarmup(p) {
			return nil, 0, "", runOne()
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := timeIt(runOne)
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, int64(count) * 256, fmt.Sprintf("count=%d", count), nil
	}
}

// ---------- net.stream-dir.upload ----------
//
// Upload ~50 small files via the streaming chunk-by-chunk Mantaray persist.
// Tests the StreamCollectionEntries hot path.
func caseStreamDirUpload(client *bee.Client, batchID swarm.BatchID) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		files := intParam(p, "files", 50)
		fileBytes := intParam(p, "file_bytes", 8192)

		buildEntries := func(salt uint64) []file.CollectionEntry {
			entries := make([]file.CollectionEntry, files)
			for i := 0; i < files; i++ {
				data := make([]byte, fileBytes)
				binary.BigEndian.PutUint64(data[:8], salt)
				binary.BigEndian.PutUint64(data[8:16], uint64(i))
				_, _ = rand.Read(data[16:])
				entries[i] = file.CollectionEntry{
					Path: fmt.Sprintf("file-%04d.bin", i),
					Data: data,
				}
			}
			return entries
		}

		runOne := func() error {
			var saltBuf [8]byte
			_, _ = rand.Read(saltBuf[:])
			salt := binary.BigEndian.Uint64(saltBuf[:])
			entries := buildEntries(salt)
			_, err := client.File.StreamCollectionEntries(ctx, batchID, entries, nil)
			return err
		}
		if isWarmup(p) {
			return nil, 0, "", runOne()
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := timeIt(runOne)
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, int64(files * fileBytes), fmt.Sprintf("files=%d bytes_each=%d", files, fileBytes), nil
	}
}

// ---------- net.soc.upload ----------
//
// Sign + upload N single-owner-chunks. SOC writes are the hot path under
// feeds, so this isolates the per-write cost.
func caseSocUpload(client *bee.Client, batchID swarm.BatchID) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		count := intParam(p, "count", 100)
		if isWarmup(p) {
			count = max(count/10, 10)
		}
		// Use a stable test key. The owner address is derived from the key.
		ec, err := crypto.HexToECDSA("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")
		if err != nil {
			return nil, 0, "", err
		}
		writer, err := client.File.MakeSOCWriter(ec)
		if err != nil {
			return nil, 0, "", err
		}
		// Pre-build identifiers so each SOC has a unique address.
		var nonce [8]byte
		_, _ = rand.Read(nonce[:])
		ids := make([]swarm.Identifier, count)
		for i := range ids {
			var raw [32]byte
			copy(raw[:8], nonce[:])
			binary.BigEndian.PutUint64(raw[8:16], uint64(i))
			id, err := swarm.NewIdentifier(raw[:])
			if err != nil {
				return nil, 0, "", err
			}
			ids[i] = id
		}
		payload := make([]byte, 256)
		_, _ = rand.Read(payload)
		runOne := func() error {
			for _, id := range ids {
				if _, err := writer.Upload(ctx, batchID, id, payload, nil); err != nil {
					return err
				}
			}
			return nil
		}
		if isWarmup(p) {
			return nil, 0, "", runOne()
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := timeIt(runOne)
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, int64(count) * int64(len(payload)), fmt.Sprintf("count=%d", count), nil
	}
}

// feedReadWithRetry calls reader.Download with sleep+retry up to maxSecs.
// On Sepolia with deferred uploads, /feeds can take 30-60s while Bee's
// exponential search probes indices. Timing INCLUDES retries — that's
// the honest wall-clock cost.
func feedReadWithRetry(ctx context.Context, reader *file.FeedReader, maxSecs int) error {
	deadline := time.Now().Add(time.Duration(maxSecs) * time.Second)
	for {
		_, err := reader.Download(ctx)
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return err
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// ---------- net.feed.write-read.fresh ----------
//
// Fresh write + immediate read against a brand-new feed topic. The first
// read pays the exponential-search index lookup cost.
func caseFeedFresh(client *bee.Client, batchID swarm.BatchID) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		runOne := func() error {
			topic, err := newRandomTopic()
			if err != nil {
				return err
			}
			signer, err := newSwarmKey()
			if err != nil {
				return err
			}
			pubAddr := signer.PublicKey().Address()
			writer := client.File.MakeFeedWriter(signer, topic)
			payload := []byte("bench-feed-update")
			if _, err := writer.Upload(ctx, batchID, payload); err != nil {
				return fmt.Errorf("feed upload: %w", err)
			}
			reader := client.File.MakeFeedReader(pubAddr, topic)
			if err := feedReadWithRetry(ctx, reader, 120); err != nil {
				return fmt.Errorf("feed download: %w", err)
			}
			return nil
		}
		if isWarmup(p) {
			return nil, 0, "", runOne()
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := timeIt(runOne)
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, 0, "", nil
	}
}

// ---------- net.feed.write-read.warm ----------
//
// After a fresh write, time N subsequent reads against the same feed (Bee
// cache warm).
func caseFeedWarm(client *bee.Client, batchID swarm.BatchID) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		reads := intParam(p, "reads", 5)
		topic, err := newRandomTopic()
		if err != nil {
			return nil, 0, "", err
		}
		signer, err := newSwarmKey()
		if err != nil {
			return nil, 0, "", err
		}
		pubAddr := signer.PublicKey().Address()
		writer := client.File.MakeFeedWriter(signer, topic)
		if _, err := writer.Upload(ctx, batchID, []byte("warm-init")); err != nil {
			return nil, 0, "", fmt.Errorf("seed write: %w", err)
		}
		reader := client.File.MakeFeedReader(pubAddr, topic)
		// Wait until the first read succeeds (Bee's /feeds endpoint can
		// take 30-60s on Sepolia for a freshly-written feed).
		if err := feedReadWithRetry(ctx, reader, 120); err != nil {
			return nil, 0, "", fmt.Errorf("warm seed read: %w", err)
		}

		runOne := func() error {
			for i := 0; i < reads; i++ {
				if _, err := reader.Download(ctx); err != nil {
					return err
				}
			}
			return nil
		}
		if isWarmup(p) {
			return nil, 0, "", runOne()
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := timeIt(runOne)
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, 0, fmt.Sprintf("reads=%d", reads), nil
	}
}

// ---------- helpers used by multiple cases ----------

func newRandomTopic() (swarm.Topic, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return swarm.Topic{}, err
	}
	return swarm.NewTopic(b[:])
}

func newSwarmKey() (swarm.PrivateKey, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return swarm.PrivateKey{}, err
	}
	return swarm.NewPrivateKey(b[:])
}

func largeHint(sizeMB int) string {
	if sizeMB >= 1024 {
		return " (set BENCH_LARGE=1)"
	}
	return ""
}

// ---------- helpers ----------

func isWarmup(p ParamEntry) bool {
	v, ok := p["warmup"].(bool)
	return ok && v
}

func intParam(p ParamEntry, key string, dflt int) int {
	v, ok := p[key]
	if !ok {
		return dflt
	}
	switch x := v.(type) {
	case int:
		return x
	case int64:
		return int(x)
	case float64:
		return int(x)
	}
	return dflt
}

func defaultIters(p ParamEntry) int {
	if s := os.Getenv("BENCH_ITERS"); s != "" {
		var n int
		if _, err := fmt.Sscanf(s, "%d", &n); err == nil && n > 0 {
			return n
		}
	}
	if v, ok := p["iters_override"].(int); ok && v > 0 {
		return v
	}
	if f, ok := p["iters_override"].(float64); ok && f > 0 {
		return int(f)
	}
	return 5
}

func drainAndDiscard(rc io.ReadCloser) (int64, error) {
	defer rc.Close()
	return io.Copy(io.Discard, rc)
}

// ---------- cpu.ecdsa.verify-1000 ----------
//
// Sign 1000 random digests once at setup, then per-iter recover the public
// key from each (digest, signature) pair. Verify under the eth-envelope is
// what feed reads do; the bee-js bigint pure-JS recover is the suspected
// pessimal case here.
func caseEcdsaVerify(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
	count := intParam(p, "count", 1000)
	pk, err := swarm.PrivateKeyFromHex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")
	if err != nil {
		return nil, 0, "", err
	}
	digests := make([][]byte, count)
	sigs := make([]swarm.Signature, count)
	for i := 0; i < count; i++ {
		d := make([]byte, 32)
		if _, err := rand.Read(d); err != nil {
			return nil, 0, "", err
		}
		s, err := pk.Sign(d)
		if err != nil {
			return nil, 0, "", err
		}
		digests[i] = d
		sigs[i] = s
	}
	if isWarmup(p) {
		count = max(count/10, 50)
	}
	iters := defaultIters(p)
	out := make([]float64, 0, iters)
	for i := 0; i < iters; i++ {
		ms, err := timeIt(func() error {
			for j := 0; j < count; j++ {
				if _, err := sigs[j].RecoverPublicKey(digests[j]); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return nil, 0, "", err
		}
		out = append(out, ms)
	}
	return out, 0, fmt.Sprintf("count=%d", count), nil
}

// ---------- cpu.manifest.lookup-large ----------
//
// Build a Mantaray with N entries (outside timing), then time M random
// Find lookups per iter (mix of hits and misses). Trie traversal hot path —
// each client's Mantaray is independent so divergence reveals lookup-cost
// differences.
func caseManifestLookupLarge(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
	entries := intParam(p, "entries", 5000)
	lookups := intParam(p, "lookups", 1000)
	root := manifest.New()
	dummyRefBytes := make([]byte, 32)
	if _, err := rand.Read(dummyRefBytes); err != nil {
		return nil, 0, "", err
	}
	dummyRef, err := swarm.NewReference(dummyRefBytes)
	if err != nil {
		return nil, 0, "", err
	}
	paths := make([][]byte, entries)
	for i := 0; i < entries; i++ {
		paths[i] = []byte(fmt.Sprintf("dir-%03d/file-%05d.bin", i%32, i))
		root.AddFork(paths[i], dummyRef, nil)
	}
	// Lookup mix: 80% hits (random existing path), 20% misses (random non-existent).
	queries := make([][]byte, lookups)
	missBuf := make([]byte, 16)
	for i := 0; i < lookups; i++ {
		if i%5 == 0 {
			_, _ = rand.Read(missBuf)
			queries[i] = []byte(fmt.Sprintf("nope-%x.bin", missBuf[:8]))
		} else {
			_, _ = rand.Read(missBuf[:4])
			idx := int(missBuf[0])<<8 | int(missBuf[1])
			queries[i] = paths[idx%entries]
		}
	}
	if isWarmup(p) {
		for _, q := range queries {
			root.Find(q)
		}
		return nil, 0, "", nil
	}
	iters := defaultIters(p)
	out := make([]float64, 0, iters)
	for i := 0; i < iters; i++ {
		ms, err := timeIt(func() error {
			for _, q := range queries {
				root.Find(q)
			}
			return nil
		})
		if err != nil {
			return nil, 0, "", err
		}
		out = append(out, ms)
	}
	return out, 0, fmt.Sprintf("entries=%d lookups=%d", entries, lookups), nil
}

// ---------- net.pin.add-list ----------
//
// Pre-upload N tiny content-addressed chunks once. Per iter: pin all N
// (POST /pins/<ref>) → GET /pins → unpin all N (DELETE /pins/<ref>).
// Total = 2N + 1 round-trips per iter; isolates per-call HTTP overhead on
// a different endpoint shape than /stamps.
func casePinAddList(client *bee.Client, batchID swarm.BatchID) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		count := intParam(p, "count", 25)
		// Pre-upload N unique tiny chunks (outside timing).
		refs := make([]swarm.Reference, count)
		for i := 0; i < count; i++ {
			payload := make([]byte, 64)
			binary.BigEndian.PutUint64(payload[:8], uint64(time.Now().UnixNano())+uint64(i))
			_, _ = rand.Read(payload[8:])
			c, err := swarm.MakeContentAddressedChunk(payload)
			if err != nil {
				return nil, 0, "", err
			}
			wire := append(append([]byte{}, c.Span[:]...), c.Payload...)
			if _, err := client.File.UploadChunk(ctx, batchID, wire, nil); err != nil {
				return nil, 0, "", fmt.Errorf("pre-upload chunk %d: %w", i, err)
			}
			refs[i] = c.Address
		}
		runOne := func() error {
			for _, r := range refs {
				if err := client.API.Pin(ctx, r); err != nil {
					return err
				}
			}
			if _, err := client.API.ListPins(ctx); err != nil {
				return err
			}
			for _, r := range refs {
				if err := client.API.Unpin(ctx, r); err != nil {
					return err
				}
			}
			return nil
		}
		if isWarmup(p) {
			return nil, 0, "", runOne()
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := timeIt(runOne)
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, 0, fmt.Sprintf("count=%d", count), nil
	}
}

// ---------- net.tags.upload-with-tag ----------
//
// POST /tags → upload via /bytes with Swarm-Tag header → GET /tags/<id>.
// Each iter creates a fresh tag. Compares against net.bytes.upload at the
// same size to surface tag-bookkeeping cost.
func caseTagsUploadWithTag(client *bee.Client, batchID swarm.BatchID, fix *Fixtures) caseFn {
	return func(ctx context.Context, p ParamEntry) ([]float64, int64, string, error) {
		sizeMB := intParam(p, "size_mb", 1)
		buf, ok := fix.Get(sizeMB)
		if !ok {
			return nil, 0, "", fmt.Errorf("fixture %dmb.bin missing", sizeMB)
		}
		salted := make([]byte, 8+len(buf))
		copy(salted[8:], buf)
		runOne := func() error {
			_, _ = rand.Read(salted[:8])
			tag, err := client.API.CreateTag(ctx)
			if err != nil {
				return err
			}
			opts := &api.RedundantUploadOptions{UploadOptions: api.UploadOptions{Tag: tag.UID}}
			if _, err := client.File.UploadData(ctx, batchID, bytes.NewReader(salted), opts); err != nil {
				return err
			}
			if _, err := client.API.GetTag(ctx, tag.UID); err != nil {
				return err
			}
			return nil
		}
		if isWarmup(p) {
			return nil, 0, "", runOne()
		}
		iters := defaultIters(p)
		out := make([]float64, 0, iters)
		for i := 0; i < iters; i++ {
			ms, err := timeIt(runOne)
			if err != nil {
				return nil, 0, "", err
			}
			out = append(out, ms)
		}
		return out, int64(len(salted)), fmt.Sprintf("size_mb=%d", sizeMB), nil
	}
}

// silence unused import warnings until more cases land
var _ = time.Now
