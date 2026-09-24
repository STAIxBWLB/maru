#!/usr/bin/env python3
"""Sample the native memory footprint of Maru and its WebKit helper processes.

Metrics (per process, per sample):
  phys_footprint       Physical footprint from /usr/bin/footprint (the number
                       Activity Monitor's "Memory" column approximates and the
                       one Jetsam accounts against). Includes compressed pages
                       and IOKit/graphics memory charged to the process.
  phys_footprint_peak  Lifetime maximum footprint of that process identity.
  rss_bytes            Resident set size from ps(1). Excludes compressed and
                       swapped pages, counts shared pages fully; NOT comparable
                       with footprint or Activity Monitor totals.
JS heap sizes are not observable from outside the WebContent process and are
never equated with either metric.

Attribution: WebKit XPC helpers (WebContent, GPU, Networking) are children of
launchd, so parent pid says nothing. They are attributed via
responsibility_get_pid_responsible_for_pid() (libquarantine), the same
responsibility relation the shared process coalition is built on. A helper
whose pid changes between samples was restarted; the summary reports the
identities seen per role so restarts are visible instead of hiding a reset.

Read-only: it never signals, launches or interacts with the target app.

Usage:
  scripts/measure-native-memory.py --label idle --duration 90 --interval 5 \
      --out docs/performance/native-memory-idle.jsonl
"""

from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import json
import platform
import re
import subprocess
import sys
import time

ROLE_BY_COMM = {
    "com.apple.WebKit.WebContent": "webcontent",
    "com.apple.WebKit.GPU": "gpu",
    "com.apple.WebKit.Networking": "networking",
}

_lib = ctypes.CDLL("/usr/lib/system/libquarantine.dylib")
_responsible = _lib.responsibility_get_pid_responsible_for_pid
_responsible.restype = ctypes.c_int
_responsible.argtypes = [ctypes.c_int]


def processes() -> list[tuple[int, str]]:
    out = subprocess.run(["ps", "-axo", "pid=,comm="], capture_output=True, text=True, check=True).stdout
    rows = []
    for line in out.splitlines():
        pid, _, comm = line.strip().partition(" ")
        rows.append((int(pid), comm.strip()))
    return rows


def find_app_pid(name: str) -> int | None:
    for pid, comm in processes():
        if comm.rsplit("/", 1)[-1] == name and _responsible(pid) == pid:
            return pid
    return None


def attributed(app_pid: int) -> dict[str, list[int]]:
    """Role -> pids whose responsible process is the app."""
    roles: dict[str, list[int]] = {"app": [app_pid]}
    for pid, comm in processes():
        role = ROLE_BY_COMM.get(comm.rsplit("/", 1)[-1])
        if role and pid != app_pid and _responsible(pid) == app_pid:
            roles.setdefault(role, []).append(pid)
    return roles


_FOOT = re.compile(r"phys_footprint(_peak)?:\s+(\d+) B")


def footprint(pid: int) -> tuple[int | None, int | None]:
    proc = subprocess.run(
        ["/usr/bin/footprint", "--pid", str(pid), "--noCategories", "-f", "bytes"],
        capture_output=True,
        text=True,
    )
    current = peak = None
    for is_peak, value in _FOOT.findall(proc.stdout):
        if is_peak:
            peak = int(value)
        else:
            current = int(value)
    return current, peak


def rss(pid: int) -> int | None:
    out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return int(out) * 1024 if out else None


def available_bytes() -> int | None:
    """Reclaimable memory: free + inactive + speculative + purgeable pages.
    macOS keeps 'Pages free' near zero by design, so free alone is no signal."""
    out = subprocess.run(["vm_stat"], capture_output=True, text=True).stdout
    page = re.search(r"page size of (\d+) bytes", out)
    if not page:
        return None
    pages = 0
    for key in ("Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"):
        found = re.search(rf"{key}:\s+(\d+)", out)
        if found:
            pages += int(found.group(1))
    return int(page.group(1)) * pages


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--app-name", default="maru", help="process comm of the app binary (default: maru)")
    ap.add_argument("--pid", type=int, help="app pid (overrides --app-name lookup)")
    ap.add_argument("--interval", type=float, default=5.0, help="seconds between samples")
    ap.add_argument("--duration", type=float, default=60.0, help="total seconds to sample")
    ap.add_argument("--out", help="JSON lines output path (default: stdout)")
    ap.add_argument("--label", default="unlabeled", help="scenario name")
    ap.add_argument("--note", default="", help="free-text context (build, fixture, open tabs)")
    ap.add_argument(
        "--min-free-mib",
        type=int,
        default=1024,
        help="stop sampling when reclaimable memory (free+inactive+speculative+purgeable) drops below this (never reproduce a machine-wide OOM)",
    )
    args = ap.parse_args()

    if platform.system() != "Darwin":
        print("macOS only (footprint, libquarantine)", file=sys.stderr)
        return 2
    app_pid = args.pid or find_app_pid(args.app_name)
    if not app_pid:
        print(f"no running process named {args.app_name!r}", file=sys.stderr)
        return 1

    sink = open(args.out, "a", encoding="utf-8") if args.out else sys.stdout
    header = {
        "kind": "header",
        "label": args.label,
        "note": args.note,
        "app_pid": app_pid,
        "started_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "os": platform.mac_ver()[0],
        "machine": platform.machine(),
        "interval_s": args.interval,
        "duration_s": args.duration,
        "metrics": {
            "phys_footprint": "bytes, /usr/bin/footprint; Activity Monitor 'Memory' approximation, Jetsam accounting",
            "phys_footprint_peak": "bytes, lifetime maximum for that process identity",
            "rss_bytes": "bytes, ps rss; excludes compressed/swapped pages, not comparable to footprint",
        },
        "attribution": "responsibility_get_pid_responsible_for_pid == app_pid",
    }
    sink.write(json.dumps(header) + "\n")
    sink.flush()

    seen: dict[str, set[int]] = {}
    series: dict[str, list[int]] = {}
    stop_reason = "duration"
    deadline = time.monotonic() + args.duration
    while True:
        available = available_bytes()
        if available is not None and available < args.min_free_mib * 1024 * 1024:
            stop_reason = f"reclaimable memory below {args.min_free_mib} MiB"
            break
        roles = attributed(app_pid)
        if not any(pid == app_pid for pid, _ in processes()):
            stop_reason = "app exited"
            break
        sample = {"kind": "sample", "t": round(time.time(), 3), "available_bytes": available, "procs": []}
        for role, pids in roles.items():
            for pid in pids:
                current, peak = footprint(pid)
                sample["procs"].append(
                    {"role": role, "pid": pid, "phys_footprint": current, "phys_footprint_peak": peak, "rss_bytes": rss(pid)}
                )
                seen.setdefault(role, set()).add(pid)
                if current is not None:
                    series.setdefault(role, []).append(current)
        sink.write(json.dumps(sample) + "\n")
        sink.flush()
        if time.monotonic() >= deadline:
            break
        time.sleep(args.interval)

    summary = {
        "kind": "summary",
        "label": args.label,
        "stop_reason": stop_reason,
        "roles": {
            role: {
                "identities": sorted(seen.get(role, ())),
                "restarts": max(0, len(seen.get(role, ())) - 1),
                "start_footprint": values[0],
                "peak_footprint": max(values),
                "end_footprint": values[-1],
                "samples": len(values),
            }
            for role, values in series.items()
        },
    }
    sink.write(json.dumps(summary) + "\n")
    sink.flush()
    if sink is not sys.stdout:
        sink.close()
        print(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
