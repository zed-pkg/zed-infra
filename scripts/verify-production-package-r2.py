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
        "User-Agent": "zed-production-r2-verifier/2",
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
            raise VerificationError(
                f"HTTP {status} for {url}: {body[:1000]}"
            ) from error
    if status not in REDIRECT_CODES or not location:
        raise VerificationError(
            f"{url} did not return an object-store redirect: "
            f"status={status}, location={location!r}"
        )
    return status, location


def verify_r2_location(
    location: str,
    endpoint_url: str,
    bucket: str,
    expected_sha256: str,
) -> tuple[str, str]:
    target = urllib.parse.urlsplit(location)
    endpoint = urllib.parse.urlsplit(endpoint_url)
    target_host = (target.hostname or "").casefold()
    endpoint_host = (endpoint.hostname or "").casefold()
    path_style = (
        target_host == endpoint_host
        and target.path.startswith(f"/{bucket}/artifacts/")
    )
    virtual_hosted = (
        target_host == f"{bucket.casefold()}.{endpoint_host}"
        and target.path.startswith("/artifacts/")
    )
    if target.scheme != "https" or not (path_style or virtual_hosted):
        raise VerificationError(
            "download redirect is not the configured R2 bucket: "
            f"scheme={target.scheme!r}, host={target_host!r}, path={target.path!r}"
        )
    if expected_sha256 not in target.path:
        raise VerificationError(
            f"R2 object path {target.path!r} does not contain {expected_sha256!r}"
        )
    query_keys = {
        key.casefold() for key in urllib.parse.parse_qs(target.query)
    }
    required = {"x-amz-algorithm", "x-amz-credential", "x-amz-signature"}
    if not required.issubset(query_keys):
        raise VerificationError(
            f"R2 redirect is missing presign fields: "
            f"{sorted(required - query_keys)}"
        )
    return target_host, target.path


def download_digest(location: str) -> tuple[str, int]:
    request = urllib.request.Request(
        location,
        headers={
            "Accept": "application/octet-stream",
            "User-Agent": "zed-production-r2-verifier/2",
        },
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
                    f"R2 object exceeded the {MAX_ARTIFACT_BYTES}-byte "
                    "verification ceiling"
                )
            digest.update(chunk)
    return digest.hexdigest(), total


def load_roundtrip(
    path: Path,
    expected_logical_package_count: int,
) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("status") != "success":
        raise VerificationError(
            f"roundtrip evidence is not successful: {value.get('status')!r}"
        )
    logical_count = value.get("logical_package_count", value.get("package_count"))
    if logical_count != expected_logical_package_count:
        raise VerificationError(
            f"expected {expected_logical_package_count} logical packages, "
            f"got {logical_count!r}"
        )
    packages = value.get("packages")
    if not isinstance(packages, list) or len(packages) != logical_count:
        raise VerificationError("roundtrip logical package evidence is incomplete")
    registry_count = value.get("registry_package_count")
    if not isinstance(registry_count, int) or registry_count < logical_count:
        raise VerificationError(
            f"invalid concrete registry package count: {registry_count!r}"
        )
    return value


def verify(args: argparse.Namespace) -> None:
    roundtrip = load_roundtrip(
        args.roundtrip,
        args.expected_logical_package_count,
    )
    token = args.token or ""
    results: list[dict[str, Any]] = []
    object_paths: set[str] = set()
    coordinates: set[str] = set()

    for logical in roundtrip["packages"]:
        source_package = str(logical.get("package", ""))
        source_sha = str(logical.get("source_sha", ""))
        concrete_rows = logical.get("registry_packages")
        if not source_package or not source_sha:
            raise VerificationError(f"invalid logical package evidence: {logical!r}")
        if not isinstance(concrete_rows, list) or not concrete_rows:
            raise VerificationError(
                f"{source_package}: no concrete registry packages were recorded"
            )

        publish = logical.get("publish") or {}
        retry = logical.get("idempotent_retry") or {}
        if publish.get("returncode") != 0 or retry.get("returncode") != 0:
            raise VerificationError(
                f"{source_package}: publish/idempotent retry did not both succeed"
            )

        for row in concrete_rows:
            coordinate = str(row.get("package", ""))
            version = str(row.get("version", ""))
            artifact = row.get("artifact")
            idempotent_artifact = row.get("idempotent_artifact")
            if (
                not coordinate
                or not version
                or not isinstance(artifact, dict)
                or not isinstance(idempotent_artifact, dict)
            ):
                raise VerificationError(
                    f"invalid concrete package evidence row: {row!r}"
                )
            if coordinate in coordinates:
                raise VerificationError(
                    f"duplicate concrete package coordinate: {coordinate}"
                )
            coordinates.add(coordinate)

            download_url = str(artifact.get("download_url", ""))
            expected_sha = str(artifact.get("sha256", ""))
            expected_size = int(artifact.get("size", -1))
            if len(expected_sha) != 64 or not download_url or expected_size < 0:
                raise VerificationError(
                    f"{coordinate}: incomplete artifact evidence"
                )
            if idempotent_artifact.get("sha256") != expected_sha:
                raise VerificationError(
                    f"{coordinate}: idempotent artifact digest drifted"
                )

            status, location = redirect_location(download_url, token)
            host, object_path = verify_r2_location(
                location,
                args.endpoint_url,
                args.bucket,
                expected_sha,
            )
            actual_sha, actual_size = download_digest(location)
            if actual_sha != expected_sha:
                raise VerificationError(
                    f"{coordinate}: R2 sha256 {actual_sha} does not match "
                    f"registry {expected_sha}"
                )
            if actual_size != expected_size:
                raise VerificationError(
                    f"{coordinate}: R2 size {actual_size} does not match "
                    f"registry {expected_size}"
                )

            object_paths.add(object_path)
            results.append(
                {
                    "source_package": source_package,
                    "package": coordinate,
                    "version": version,
                    "target": row.get("target"),
                    "source_sha": source_sha,
                    "artifact_sha256": actual_sha,
                    "artifact_size": actual_size,
                    "redirect_status": status,
                    "r2_host": host,
                    "r2_object_path": object_path,
                }
            )

    expected_registry_count = roundtrip["registry_package_count"]
    if len(results) != expected_registry_count:
        raise VerificationError(
            "R2 verification did not cover every concrete registry package: "
            f"verified={len(results)}, expected={expected_registry_count}"
        )
    if len(coordinates) != expected_registry_count:
        raise VerificationError(
            "R2 verification did not produce unique concrete coordinates"
        )

    output = {
        "schema": 2,
        "status": "success",
        "logical_package_count": args.expected_logical_package_count,
        "registry_package_count": expected_registry_count,
        "verified_package_count": len(results),
        "unique_object_count": len(object_paths),
        "bucket": args.bucket,
        "endpoint_host": urllib.parse.urlsplit(args.endpoint_url).hostname,
        "packages": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--roundtrip", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--endpoint-url", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument(
        "--expected-logical-package-count",
        type=int,
        default=19,
    )
    parser.add_argument("--token", default=os.environ.get("ZED_PKG_TOKEN", ""))
    return parser.parse_args()


if __name__ == "__main__":
    verify(parse_args())
