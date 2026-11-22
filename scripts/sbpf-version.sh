#!/usr/bin/env bash
# The SBPF version of a program, from its ELF header.
#
#   scripts/sbpf-version.sh <program.so>                prints for example "SBPF v3 (e_machine 247, e_flags 3)"
#   scripts/sbpf-version.sh --expect v3 <program.so>    and fails unless the program is SBPF v3
#
# An SBPF v3 program has e_machine 247 (EM_BPF) and e_flags 3. Releases up to
# v0.4.1 are SBPF v0: e_machine 263 (EM_SBPF) and e_flags 0. Once SIMD-0500 is
# active the clusters refuse to deploy SBPF v0, v1 and v2 programs, upgrades
# included, so every release from now on is SBPF v3.
set -euo pipefail

expect=""
if [[ ${1:-} == --expect ]]; then
  expect=${2:?usage: scripts/sbpf-version.sh [--expect v3] <program.so>}
  shift 2
fi
so=${1:?usage: scripts/sbpf-version.sh [--expect v3] <program.so>}

# the first 52 bytes, one unsigned byte each (no assumption about the host's byte order)
read -r -a h <<<"$(od -An -v -tu1 -N52 "$so" | tr -s ' \n' '  ')"
if [[ ${#h[@]} -lt 52 || "${h[*]:0:6}" != "127 69 76 70 2 1" ]]; then
  echo "$so: not a 64 bit little endian ELF file" >&2
  exit 1
fi
machine=$((h[18] | h[19] << 8))
flags=$((h[48] | h[49] << 8 | h[50] << 16 | h[51] << 24))
echo "SBPF v$flags (e_machine $machine, e_flags $flags)"

if [[ -n $expect ]]; then
  if [[ v$flags != "$expect" || ($expect == v3 && $machine != 247) ]]; then
    echo "$so: expected SBPF $expect" >&2
    exit 1
  fi
fi
