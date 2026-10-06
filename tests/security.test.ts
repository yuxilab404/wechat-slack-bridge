import { test } from "node:test";
import ts from "typescript";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUrl, publicAddress, Http, Fault } from "../src/http.js";
import { aesKey, encrypt, decrypt } from "../src/media.js";
import { schema, privateJson } from "../src/config.js";

test("URL、地址和密钥边界拒绝危险输入", () => {
  for (const url of [
    "http://files.slack.com/a",
    "https://files.slack.com.evil.invalid/a",
    "https://user:secret@files.slack.com/a",
    "https://files.slack.com:8080/a",
    "https://127.0.0.1/a",
  ])
    assert.throws(() => checkUrl(url, ["files.slack.com"]));
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "0.0.0.0",
    "224.0.0.1",
  ])
    assert.equal(publicAddress(ip), false);
  assert.throws(() => checkUrl("https://127.0.0.1/test", ["127.0.0.1"]));
  assert.equal(publicAddress("8.8.8.8"), true);
  const key = Buffer.alloc(16, 7),
    bytes = Buffer.from("图片字节");
  for (const encoded of [
    key.toString("base64"),
    Buffer.from(key.toString("hex")).toString("base64"),
  ])
    assert.deepEqual(decrypt(encrypt(bytes, key), aesKey(encoded)), bytes);
  assert.throws(() => aesKey("bad"));
  assert.throws(() => aesKey("", "invalid-secret-key"));
});
test("HTTP 限额、重定向与错误均不暴露响应内容", async () => {
  const http = new Http(async () => ({
    status: 302,
    headers: new Headers({ location: "https://evil.invalid/private-secret" }),
    bytes: Buffer.from("private-secret"),
  }));
  await assert.rejects(
    http.bytes("https://files.slack.com/test", ["files.slack.com"]),
    (e) => e instanceof Fault && !e.message.includes("private-secret"),
  );
  const huge = new Http(async () => ({
    status: 200,
    headers: new Headers(),
    bytes: Buffer.alloc(20),
  }));
  await assert.rejects(
    huge.bytes(
      "https://files.slack.com/test",
      ["files.slack.com"],
      "GET",
      {},
      undefined,
      10,
    ),
    /超过限额/,
  );
});
test("严格配置及凭据权限，错误不回显输入", () => {
  const sample = JSON.parse(readFileSync("config.example.json", "utf8"));
  assert.ok(schema.safeParse(sample).success);
  assert.equal(schema.safeParse({ ...sample, unknown: "test" }).success, false);
  assert.equal(schema.safeParse({ ...sample, maxFileBytes: 0 }).success, false);
  const dir = mkdtempSync(join(tmpdir(), "secret-test-"));
  try {
    const f = join(dir, "secret");
    writeFileSync(f, "{}");
    chmodSync(f, 0o644);
    assert.throws(() => privateJson(f), /属主/);
    chmodSync(f, 0o600);
    assert.deepEqual(privateJson(f), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("仓库敏感内容扫描与镜像白名单", () => {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const token = new RegExp(
    "xox[baprs]-" +
      "[A-Za-z0-9-]{20,}|gh[pousr]_" +
      "[A-Za-z0-9]{30,}|github_pat_" +
      "[A-Za-z0-9_]{30,}",
  );
  for (const f of files) {
    assert.ok(!/^(secrets|state|media|logs)\//.test(f), `敏感目录被跟踪：${f}`);
    const body = readFileSync(f, "utf8");
    assert.ok(!token.test(body), `疑似凭据：${f}`);
  }
  assert.ok(readFileSync(".dockerignore", "utf8").startsWith("*\n"));
  assert.match(readFileSync(".gitignore", "utf8"), /secrets\//);
  for (const f of files.filter((f) => f.startsWith("src/"))) {
    const s = readFileSync(f, "utf8");
    const ast = ts.createSourceFile(f, s, ts.ScriptTarget.Latest, true);
    function inspect(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(ast) === "console"
      ) {
        assert.ok(
          node.arguments.every((a) => ts.isStringLiteral(a)),
          `日志参数必须固定：${f}`,
        );
      }
      ts.forEachChild(node, inspect);
    }
    inspect(ast);
  }
});
