import assert from "node:assert/strict";
import test from "node:test";

import { encodeNativeCoordinate } from "./native-registry-catalog.js";
import {
  isAllowedTerraformModuleArtifact,
  terraformModuleCoordinate,
  terraformModuleDownloadCandidate,
  terraformModuleDownloadUrl,
  terraformModuleVersions,
  terraformModuleVersionsUrl,
} from "./native-terraform-module.js";

const NAME = encodeNativeCoordinate("hashicorp/consul/aws");

test("Terraform module coordinates require namespace/name/system", () => {
  assert.deepEqual(terraformModuleCoordinate(NAME), {
    coordinate: "hashicorp/consul/aws",
    namespace: "hashicorp",
    name: "consul",
    system: "aws",
  });
  assert.equal(terraformModuleCoordinate("hashicorp/consul"), null);
  assert.equal(terraformModuleCoordinate(encodeNativeCoordinate("hashicorp/../aws")), null);
});

test("Terraform module protocol URLs are exact public-registry endpoints", () => {
  assert.equal(
    terraformModuleVersionsUrl(NAME),
    "https://registry.terraform.io/v1/modules/hashicorp/consul/aws/versions",
  );
  assert.equal(
    terraformModuleDownloadUrl(NAME, "0.0.1"),
    "https://registry.terraform.io/v1/modules/hashicorp/consul/aws/0.0.1/download",
  );
  assert.equal(terraformModuleDownloadUrl(NAME, "../0.0.1"), null);
});

test("Terraform version discovery reads only the first module version set", () => {
  assert.deepEqual(
    terraformModuleVersions({
      modules: [
        { versions: [{ version: "2.0.0" }, { version: "1.1.0" }, { version: "1.0.0" }] },
        { versions: [{ version: "999.0.0" }] },
      ],
    }),
    ["2.0.0", "1.1.0", "1.0.0"],
  );
  assert.deepEqual(terraformModuleVersions({ modules: [] }), []);
});

test("documented GitHub X-Terraform-Get form becomes a confined tar.gz candidate", () => {
  const response = new Response(null, {
    status: 204,
    headers: {
      "x-terraform-get":
        "https://api.github.com/repos/hashicorp/terraform-aws-consul/tarball/v0.0.1//*?archive=tar.gz",
    },
  });
  const candidate = terraformModuleDownloadCandidate(response, NAME, "0.0.1");
  assert.deepEqual(candidate, {
    url: "https://codeload.github.com/hashicorp/terraform-aws-consul/tar.gz/v0.0.1",
    sha256: "",
    size: 0,
    format: "tar.gz",
    validation: {
      kind: "terraform-module-github-tarball",
      owner: "hashicorp",
      repo: "terraform-aws-consul",
      reference: "v0.0.1",
      module: "hashicorp/consul/aws",
      version: "0.0.1",
    },
  });
  assert.equal(isAllowedTerraformModuleArtifact(candidate.url, candidate), true);
  assert.equal(
    isAllowedTerraformModuleArtifact(
      "https://codeload.github.com/hashicorp/terraform-aws-consul/tar.gz/v0.0.2",
      candidate,
    ),
    false,
  );
  assert.equal(
    isAllowedTerraformModuleArtifact(
      "https://codeload.github.com/attacker/terraform-aws-consul/tar.gz/v0.0.1",
      candidate,
    ),
    false,
  );
});

test("Terraform staging rejects arbitrary go-getter, relative, recursive and malformed sources", () => {
  const values = [
    "git::https://github.com/hashicorp/terraform-aws-consul.git?ref=v0.0.1",
    "/downloads/module.tar.gz",
    "../downloads/module.tar.gz",
    "hashicorp/consul/aws",
    "https://registry.terraform.io/v1/modules/hashicorp/consul/aws/0.0.1/download",
    "https://evil.test/repos/hashicorp/terraform-aws-consul/tarball/v0.0.1//*?archive=tar.gz",
    "https://user:pass@api.github.com/repos/hashicorp/terraform-aws-consul/tarball/v0.0.1//*?archive=tar.gz",
    "https://api.github.com:444/repos/hashicorp/terraform-aws-consul/tarball/v0.0.1//*?archive=tar.gz",
    "https://api.github.com/repos/hashicorp/terraform-aws-consul/tarball/v0.0.1?archive=tar.gz",
  ];
  for (const value of values) {
    const response = new Response(null, {
      status: 204,
      headers: { "x-terraform-get": value },
    });
    assert.equal(terraformModuleDownloadCandidate(response, NAME, "0.0.1"), null, value);
  }

  const wrongStatus = new Response(null, {
    status: 200,
    headers: {
      "x-terraform-get":
        "https://api.github.com/repos/hashicorp/terraform-aws-consul/tarball/v0.0.1//*?archive=tar.gz",
    },
  });
  assert.equal(terraformModuleDownloadCandidate(wrongStatus, NAME, "0.0.1"), null);
});
