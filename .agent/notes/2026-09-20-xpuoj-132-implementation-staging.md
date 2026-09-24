# XPUOJ 132 implementation staging

- Added private-workspace engineering notes for display problem 132 after verifying
  its matching platform record.
- Captured the public tensor ABI, global-scale quantization semantics, published
  shapes, numerical tolerance, available H800 language backends, and local host
  limitations in `workspaces/xpuoj-132/implementation/README.md`.
- Added a CPU-only PyTorch reference/contract check and deliberate, nonfunctional
  Triton and CUDA submission-interface stubs.
- Added `candidate_v1.py`, an explicitly exploratory three-launch Triton design:
  paired partial max reduction, paired exact-division/ties-to-even quantization,
  then INT8/INT32 GEMM with FP32 dequantization. It has not been compiled on the
  platform and remains subject to M04 review.
- Added a deterministic CPU-only comparison of its integer arithmetic against
  the statement's FP32 quantized matmul for all ten published shapes.
- Added `CANDIDATE_V1.md` with the design, bounded evidence, and unresolved
  platform/toolchain risks for review before any remote test.
- No project core or third-party source was changed. No remote custom test or
  submission was started, and no platform score/pass is claimed.
