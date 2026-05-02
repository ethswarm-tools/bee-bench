module github.com/ethswarm-tools/bee-bench/runner-go

go 1.25.4

require github.com/ethswarm-tools/bee-go v0.0.0

require (
	github.com/ProjectZKM/Ziren/crates/go-runtime/zkvm_runtime v0.0.0-20251001021608-1fe7b43fc4d6 // indirect
	github.com/decred/dcrd/dcrec/secp256k1/v4 v4.0.1 // indirect
	github.com/ethereum/go-ethereum v1.16.8 // indirect
	github.com/gorilla/websocket v1.5.3 // indirect
	github.com/holiman/uint256 v1.3.2 // indirect
	golang.org/x/crypto v0.36.0 // indirect
	golang.org/x/sys v0.36.0 // indirect
)

replace github.com/ethswarm-tools/bee-go => ../../bee-go
