#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

MAX_ARTIFACT_BYTES = 100 * 1024 * 1024
REDIRECT_CODES = {301, 302, 303, 307, 308}


class VerificationError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def redirect_location(url: str, token: str) -> tuple[int, str]:
    headers = {
        "Accept": "application/octet-stream",
        "User-Agent": "zed-production-r2-verifier/1",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=60) as response:
            status = response.status
            location = response.headers.get("Location", "")
    except urllib.error.HTTPError as error:
        status = error.code
        location = error.headers.get("Location", "")
        if status not in REDIRECT_CODES:
            body = error.read().decode("utf-8", errors="replace")
            raise VerificationError(f"HTTP {status} for {url}: {body[:1000]}") from error
    if status not in REDIRECT_CODES or not location:
        raise VerificationError(
            f"{url} did not return an object-store redirect: status={status}, location={location!r}"
        )
    return status, location


def verify_r2_location(location: str, endpoint_url: str, bucket: str) -> tuple[str, str]:
    target = urllib.parse.urlsplit(location)
    endpoint = urllib.parse.urlsplit(endpoint_url)
    target_host = (target.hostname or "").casefold()
    endpoint_host = (endpoint.hostname or "").casefold()
    path_style = target_host == endpoint_host and target.path.startswith(f"/{bucket}/artifacts/")
    virtual_hosted = (
        target_host == f"{bucket.casefold()}.{endpoint_host}"
        and target.path.startswith("/artifacts/")
    )
    if target.scheme != "https" or not (path_style or virtual_hosted):
        raise VerificationError(
            "download redirect is not the configured R2 bucket: "
            f"scheme={target.scheme!r}, host={target_host!r}, path={target.path!r}"
        )
    query_keys = {key.casefold() for key in urllib.parse.parse_qs(target.query)}
    required = {"x-amz-algorithm", "x-amz-credential", "x-amz-signature"}
    if not required.issubset(query_keys):
        raise VerificationError(
            f"R2 redirect is missing presign fields: {sorted(required - query_keys)}"
        )
    return target_host, target.path


def download_digest(location: str) -> tuple[str, int]:
    request = urllib.request.Request(
        location,
        headers={"Accept": "application/octet-stream", "User-Agent": "zed-production-r2-verifier/1"},
    )
    digest = hashlib.sha256()
    total = 0
    with urllib.request.urlopen(request, timeout=180) as response:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_ARTIFACT_BYTES:
                raise VerificationError(
                    f"R2 object exceeded the {MAX_ARTIFACT_BYTES}-byte verification ceiling"
                )
            digest.update(chunk)
    return digest.hexdigest(), total


def load_roundtrip(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("status") != "success":
        raise VerificationError(f"roundtrip evidence is not successful: {value.get('status')!r}")
    if value.get("package_count") != 19:
        raise VerificationError(f"expected 19 packages, got {value.get('package_count')!r}")
    packages = value.get("packages")
    if not isinstance(packages, list) or len(packages) != 19:
        raise VerificationError("roundtrip package evidence is incomplete")
    return value


def verify(args: argparse.Namespace) -> None:
    roundtrip = load_roundtrip(args.roundtrip)
    token = args.token or ""
    results: list[dict[str, Any]] = []
    object_paths: set[str] = set()
    coordinates: set[str] = set()

    for row in roundtrip["packages"]:
        coordinate = str(row.get("package", ""))
        artifact = row.get("artifact")
        if not coordinate or not isinstance(artifact, dict):
            raise VerificationError(f"invalid package evidence row: {row!r}")
        if coordinate in coordinates:
            raise VerificationError(f"duplicate package coordinate: {coordinate}")
        coordinates.add(coordinate)
        download_url = str(artifact.get("download_url", ""))
        expected_sha = str(artifact.get("sha256", ""))
        expected_size = int(artifact.get("size", -1))
        if len(expected_sha) != 64 or not download_url:
            raise VerificationError(f"{coordinate}: incomplete artifact evidence")

        status, location = redirect_location(download_url, token)
        host, object_path = verify_r2_location(location, args.endpoint_url, args.bucket)
        actual_sha, actual_size = download_digest(location)
        if actual_sha != expected_sha:
            raise VerificationError(
                f"{coordinate}: R2 sha256 {actual_sha} does not match registry {expected_sha}"
            )
        if actual_size != expected_size:
            raise VerificationError(
                f"{coordinate}: R2 size {actual_size} does not match registry {expected_size}"
            )
        object_paths.add(object_path)
        results.append(
            {
                "package": coordinate,
                "version": row.get("version"),
                "source_sha": row.get("source_sha"),
                "artifact_sha256": actual_sha,
                "artifact_size": actual_size,
                "redirect_status": status,
                "r2_host": host,
                "r2_object_path": object_path,
            }
        )

    if len(results) != 19 or len(coordinates) != 19 or len(object_paths) != 19:
        raise VerificationError(
            "R2 verification did not produce 19 unique packages and 19 unique objects: "
            f"results={len(results)}, packages={len(coordinates)}, objects={len(object_paths)}"
        )

    output = {
        "schema": 1,
        "status": "success",
        "package_count": 19,
        "unique_object_count": len(object_paths),
        "bucket": args.bucket,
        "endpoint_host": urllib.parse.urlsplit(args.endpoint_url).hostname,
        "packages": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--roundtrip", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--endpoint-url", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--token", default=os.environ.get("ZED_PKG_TOKEN", ""))
    return parser.parse_args()


if __name__ == "__main__":
    verify(parse_args())
