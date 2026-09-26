import assert from "node:assert/strict";
import test from "node:test";

import {
  allowedNativeGatewayUrl,
  nativeGatewayRequestHeaders,
  parseNativeGatewayPath,
} from "./native-gateway.js";

const cases = [
  ["maven-central", "https://repo.maven.apache.org/maven2/com/google/guava/guava/maven-metadata.xml"],
  ["packagist", "https://repo.packagist.org/p2/monolog/monolog.json"],
  ["go-proxy", "https://proxy.golang.org/golang.org/x/text/@v/list"],
  ["conan-center", "https://center2.conan.io/v2/conans/zlib/1.3.1/_/_/revisions"],
  ["clojars", "https://repo.clojars.org/org/clojure/clojure/maven-metadata.xml"],
  ["cpan", "https://fastapi.metacpan.org/v1/module/JSON"],
  ["luarocks", "https://luarocks.org/manifests/luarocks/manifest-5.4"],
  ["opam", "https://opam.ocaml.org/packages/dune/dune.3.17.2/opam"],
  ["julia-general", "https://pkg.julialang.org/registries"],
  ["cran", "https://cran.r-project.org/src/contrib/PACKAGES.gz"],
  ["conda-forge", "https://conda.anaconda.org/conda-forge/linux-64/repodata.json.zst"],
  ["cocoapods", "https://cdn.cocoapods.org/all_pods_versions_0_0_0.txt"],
  ["jsr", "https://jsr.io/@std/path/meta.json"],
  ["terraform-registry", "https://registry.terraform.io/v1/modules/hashicorp/consul/aws/versions"],
  ["docker-hub", "https://registry-1.docker.io/v2/library/alpine/manifests/latest"],
];

test("protocol gateway recognizes every complex provider and its admitted public host", () => {
  for (const [token, rawUrl] of cases) {
    const route = parseNativeGatewayPath(`/v1/native/${token}`);
    assert.ok(route, token);
    assert.equal(route.provider.id, token, token);
    assert.equal(allowedNativeGatewayUrl(route.provider, rawUrl)?.toString(), rawUrl, token);
  }
});

test("normalized providers can also use the protocol gateway when the CLI needs native wire semantics", () => {
  for (const [token, rawUrl] of [
    ["npm", "https://registry.npmjs.org/lodash"],
    ["crates-io", "https://crates.io/api/v1/crates/serde"],
    ["pypi", "https://pypi.org/pypi/requests/json"],
    ["nuget", "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json"],
    ["rubygems", "https://rubygems.org/api/v1/versions/rails.json"],
    ["hex", "https://hex.pm/api/packages/decimal"],
    ["hackage", "https://hackage.haskell.org/package/aeson.json"],
  ]) {
    const route = parseNativeGatewayPath(`/v1/native/${token}`);
    assert.ok(route, token);
    assert.ok(allowedNativeGatewayUrl(route.provider, rawUrl), token);
  }
});

test("gateway refuses arbitrary origins, plaintext, userinfo, ports, and traversal", () => {
  const route = parseNativeGatewayPath("/v1/native/go-proxy");
  assert.ok(route);
  for (const rawUrl of [
    "https://evil.example/golang.org/x/text/@v/list",
    "http://proxy.golang.org/golang.org/x/text/@v/list",
    "https://user:pass@proxy.golang.org/golang.org/x/text/@v/list",
    "https://proxy.golang.org:8443/golang.org/x/text/@v/list",
    "https://proxy.golang.org/golang.org/x/text/../secret",
    "https://proxy.golang.org/golang.org/x/text/%2e%2e/secret",
  ]) {
    assert.equal(allowedNativeGatewayUrl(route.provider, rawUrl), null, rawUrl);
  }
});

test("gateway request headers never forward caller credentials", () => {
  const request = new Request("https://registry.zpkg.net/v1/native/maven-central", {
    headers: {
      accept: "application/xml",
      authorization: "Bearer secret",
      cookie: "session=secret",
      range: "bytes=0-99",
      "if-none-match": '"etag"',
      "x-api-key": "secret",
    },
  });
  const headers = nativeGatewayRequestHeaders(request);
  assert.equal(headers.get("accept"), "application/xml");
  assert.equal(headers.get("range"), "bytes=0-99");
  assert.equal(headers.get("if-none-match"), '"etag"');
  assert.equal(headers.has("authorization"), false);
  assert.equal(headers.has("cookie"), false);
  assert.equal(headers.has("x-api-key"), false);
});

test("unknown provider paths are not gateway routes", () => {
  assert.equal(parseNativeGatewayPath("/v1/native/artifactory"), null);
  assert.equal(parseNativeGatewayPath("/v1/native/../../evil"), null);
  assert.equal(parseNativeGatewayPath("/v1/native/go-proxy/extra"), null);
});
