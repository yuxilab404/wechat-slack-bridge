import { test } from "node:test";
import { fetch } from "undici";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { schema, sessionSchema } from "../src/config.js";
import { Http, type Transport } from "../src/http.js";
import { Store } from "../src/store.js";
import { Weixin, Slack } from "../src/adapters.js";
import { Bridge } from "../src/bridge.js";
import { encrypt, decrypt, aesKey } from "../src/media.js";
import { login } from "../src/login.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
  "base64",
);
const key = Buffer.alloc(16, 9);
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const session = {
  bot_token: "fixture-weixin-token",
  ilink_bot_id: "fixture-account",
  ilink_user_id: "fixture-owner",
  baseurl: "https://ilinkai.weixin.qq.com",
};
async function setup(t: any, activate = true) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  const calls: { path: string; body: any; bytes: Buffer }[] = [];
  let root = 0;
  const failures = new Map<string, { status: number; count: number }>();
  let uploadKey = key;
  let mime = "image/png";
  let url = "https://files.slack.com/private/test";
  let updates: any;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const path = new URL(req.url!, "http://fixture.invalid").pathname;
    let body: any = {};
    try {
      body = JSON.parse(bytes.toString());
    } catch {
      /* 原始媒体请求无需 JSON。 */
    }
    calls.push({ path, body, bytes });
    const failure = failures.get(path);
    if (failure && failure.count-- > 0) {
      if (failure.status === 0) {
        req.socket.destroy();
        return;
      }
      res.writeHead(failure.status, { "Retry-After": "2" });
      res.end("{}");
      return;
    }
    let data: any = { ok: true, ret: 0 };
    if (path.endsWith("/getupdates")) {
      if (updates) {
        res.end(JSON.stringify(updates));
        return;
      }
      res.end(
        '{"ret":0,"msgs":[' +
          JSON.stringify(message("18446744073709551615")).replace(
            '"18446744073709551615"',
            "18446744073709551615",
          ) +
          '],"get_updates_buf":"fixture-cursor"}',
      );
      return;
    }
    if (path.endsWith("/chat.postMessage"))
      data = { ok: true, ts: `${++root}.000001` };
    if (path.endsWith("/files.getUploadURLExternal"))
      data = {
        ok: true,
        file_id: "fixture-file",
        upload_url: "https://files.slack.com/upload/test",
      };
    if (path.endsWith("/files.info"))
      data = {
        ok: true,
        file: {
          id: "fixture-file",
          size: png.length,
          mimetype: mime,
          url_private_download: url,
        },
      };
    if (path === "/private/test") {
      res.end(png);
      return;
    }
    if (path === "/c2c/download") {
      res.end(encrypt(png, key));
      return;
    }
    if (path.endsWith("/getuploadurl")) {
      uploadKey = Buffer.from(body.aeskey, "hex");
      data = {
        upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload",
      };
    }
    if (path === "/c2c/upload") {
      assert.equal(digest(decrypt(bytes, uploadKey)), digest(png));
      res.setHeader("x-encrypted-param", "fixture-param");
    }
    if (path.endsWith("/get_bot_qrcode"))
      data = { qrcode: "fixture-qr", qrcode_img_content: "fixture-qr-content" };
    if (path.endsWith("/get_qrcode_status"))
      data = { status: "confirmed", ...session };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  // 仅测试注入：将通过生产 URL 校验的请求转到本机假服务；生产配置没有此开关。
  const transport: Transport = async (raw, method, headers, body) => {
    const u = new URL(raw);
    const r = await fetch(
      `http://127.0.0.1:${address.port}${u.pathname}${u.search}`,
      { method, headers, body },
    );
    return {
      status: r.status,
      headers: new Headers([...r.headers]),
      bytes: Buffer.from(await r.arrayBuffer()),
    };
  };
  const c = schema.parse({
    team: "fixture-team",
    channel: "fixture-channel",
    dotUser: "fixture-dot",
    dotBot: "fixture-dot-bot",
    dotApp: "fixture-dot-app",
    bridgeUser: "fixture-bridge",
    secretFile: join(dir, "secrets.json"),
    stateDir: dir,
  });
  const http = new Http(transport),
    wx = new Weixin(c, session, http),
    slack = new Slack(c, "fixture-slack-token", http);
  let store = new Store(c);
  let bridge = new Bridge(c, store, wx, slack);
  if (activate) {
    const confirmation = message("0", [
      { type: 1, text_item: { text: bridge.activationCommand } },
    ]);
    confirmation.create_time_ms = Date.now() - 1000;
    bridge.ingest({ msgs: [confirmation] });
  }
  t.after(async () => {
    store.close();
    await new Promise<void>((r, e) =>
      server.close((error) => (error ? e(error) : r())),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    c,
    http,
    wx,
    slack,
    calls,
    failures,
    get store() {
      return store;
    },
    get bridge() {
      return bridge;
    },
    restart() {
      store.close();
      store = new Store(c);
      bridge = new Bridge(c, store, wx, slack);
    },
    setUpdates(v: any) {
      updates = v;
    },
    setMime(v: string) {
      mime = v;
    },
    setUrl(v: string) {
      url = v;
    },
    ready() {
      store.run("UPDATE events SET due=0");
      store.run("UPDATE jobs SET due=0 WHERE status='pending'");
    },
  };
}
function message(
  id = "1",
  items: any[] = [{ type: 1, text_item: { text: "你好，测试" } }],
) {
  return {
    message_id: id,
    create_time_ms: Date.now(),
    from_user_id: session.ilink_user_id,
    to_user_id: session.ilink_bot_id,
    message_type: 1,
    message_state: 2,
    context_token: `虚构上下文-${id}`,
    item_list: items,
  };
}
function event(
  root = "1.000001",
  text = "【最终回复】测试回复",
  files: any[] = [],
) {
  return {
    team_id: "fixture-team",
    event: {
      type: "message",
      subtype: "bot_message",
      channel: "fixture-channel",
      user: "fixture-dot",
      bot_id: "fixture-dot-bot",
      app_id: "fixture-dot-app",
      ts: "100.000001",
      thread_ts: root,
      text,
      files,
    },
  };
}
const batch = (...msgs: any[]) => ({ msgs, get_updates_buf: "fixture-cursor" });

test("微信文字通过真实 HTTP 转 Slack，uint64 无损并恢复游标", async (t) => {
  const h = await setup(t);
  h.bridge.ingest(await h.wx.updates(""));
  await h.bridge.work();
  assert.equal(
    h.calls.find((x) => x.path.endsWith("chat.postMessage"))!.body.text,
    "【微信消息就绪】\n你好，测试",
  );
  assert.equal(
    JSON.parse(h.store.get("SELECT payload FROM inbound").payload).message_id,
    "18446744073709551615",
  );
  h.restart();
  assert.equal(h.store.meta("cursor"), "fixture-cursor");
  h.bridge.ingest(await h.wx.updates("fixture-cursor"));
  await h.bridge.work();
  assert.equal(
    h.calls.filter((x) => x.path.endsWith("chat.postMessage")).length,
    1,
  );
});
test("微信图片解密后经外部上传进入根线程，原始字节哈希一致", async (t) => {
  const h = await setup(t);
  h.bridge.ingest(
    batch(
      message("2", [
        { type: 1, text_item: { text: "附图" } },
        {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: "fixture",
              aes_key: key.toString("base64"),
            },
          },
        },
      ]),
    ),
  );
  await h.bridge.work();
  assert.equal(
    digest(h.calls.find((x) => x.path === "/upload/test")!.bytes),
    digest(png),
  );
  assert.equal(
    h.calls.find((x) => x.path.endsWith("files.completeUploadExternal"))!.body
      .thread_ts,
    "1.000001",
  );
  assert.ok(!h.calls.some((x) => x.path.endsWith("files.upload")));
});
test("dot 文字回原微信上下文，重复与重启不重发，拒绝确认文字", async (t) => {
  const h = await setup(t);
  h.bridge.ingest(batch(message()));
  await h.bridge.work();
  h.bridge.event(event("1.000001", "收到"));
  h.ready();
  await h.bridge.work();
  assert.equal(h.calls.filter((x) => x.path.endsWith("sendmessage")).length, 0);
  const e = event();
  e.event.ts = "101.000001";
  h.bridge.event(e);
  h.ready();
  await h.bridge.work();
  h.restart();
  h.bridge.event(e);
  h.ready();
  await h.bridge.work();
  const sent = h.calls.filter((x) => x.path.endsWith("sendmessage"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body.msg.context_token, "虚构上下文-1");
  assert.equal(sent[0]!.body.msg.item_list[0].text_item.text, "测试回复");
});
test("dot 图片授权下载、AES 上传、微信 IMAGE 原始哈希一致", async (t) => {
  const h = await setup(t);
  h.bridge.ingest(batch(message()));
  await h.bridge.work();
  h.bridge.event(event("1.000001", "", [{ id: "fixture-file" }]));
  h.ready();
  await h.bridge.work();
  const item = h.calls.find((x) => x.path.endsWith("sendmessage"))!.body.msg
    .item_list[0];
  assert.equal(item.type, 2);
  const bytes = h.calls.find((x) => x.path === "/c2c/upload")!.bytes;
  assert.equal(
    digest(decrypt(bytes, aesKey(item.image_item.media.aes_key))),
    digest(png),
  );
});
test("文字成功而图片限流时只重试图片并遵守 Retry-After", async (t) => {
  const h = await setup(t);
  h.failures.set("/api/files.info", { status: 429, count: 1 });
  h.bridge.ingest(batch(message()));
  await h.bridge.work();
  h.bridge.event(
    event("1.000001", "【最终回复】附图", [{ id: "fixture-file" }]),
  );
  h.ready();
  await h.bridge.work();
  assert.equal(h.calls.filter((x) => x.path.endsWith("sendmessage")).length, 1);
  assert.ok(
    h.store.get("SELECT due FROM jobs WHERE status='pending'").due > Date.now(),
  );
  h.restart();
  h.ready();
  await h.bridge.work();
  assert.equal(h.calls.filter((x) => x.path.endsWith("sendmessage")).length, 2);
});
test("乱序到达与流式更新只使用确定线程和最新最终正文", async (t) => {
  const h = await setup(t);
  const latest = event("2.000001", "【最终回复】第二轮");
  latest.event.ts = "105.000001";
  h.bridge.event(latest);
  h.bridge.ingest(batch(message("1"), message("2")));
  await h.bridge.work();
  h.ready();
  await h.bridge.work();
  assert.equal(
    h.calls.find((x) => x.path.endsWith("sendmessage"))!.body.msg.context_token,
    "虚构上下文-2",
  );
  const original = event("1.000001", "草稿");
  h.bridge.event(original);
  h.bridge.event({
    team_id: "fixture-team",
    event: {
      type: "message",
      subtype: "message_changed",
      channel: "fixture-channel",
      event_ts: "102.000001",
      message: {
        ...original.event,
        text: "【最终回复】更新后",
        edited: { ts: "102.000001" },
      },
    },
  });
  h.bridge.event(original);
  h.ready();
  await h.bridge.work();
  assert.equal(
    h.calls.filter((x) => x.path.endsWith("sendmessage")).at(-1)!.body.msg
      .item_list[0].text_item.text,
    "更新后",
  );
});
test("错误团队、频道、回复者、机器人、应用和桥自己都不能回环", async (t) => {
  const h = await setup(t);
  h.bridge.ingest(
    batch(
      message(),
      { ...message("2"), group_id: "fixture-group" },
      { ...message("3"), from_user_id: "fixture-stranger" },
    ),
  );
  await h.bridge.work();
  for (const k of ["channel", "user", "bot_id", "app_id"]) {
    const e = event();
    (e.event as any)[k] = "fixture-wrong";
    h.bridge.event(e);
  }
  const wrong = event();
  wrong.team_id = "fixture-wrong";
  h.bridge.event(wrong);
  const self = event();
  self.event.user = "fixture-bridge";
  h.bridge.event(self);
  h.ready();
  await h.bridge.work();
  assert.equal(h.store.get("SELECT count(*) AS n FROM inbound").n, 1);
  assert.equal(h.store.get("SELECT count(*) AS n FROM events").n, 0);
});
test("缺少上下文时失败关闭；非图片文件给出中文说明", async (t) => {
  const h = await setup(t);
  h.bridge.ingest(batch({ ...message(), context_token: "" }));
  await h.bridge.work();
  h.bridge.event(event());
  h.ready();
  await h.bridge.work();
  assert.equal(h.calls.filter((x) => x.path.endsWith("sendmessage")).length, 0);
  h.bridge.ingest(batch(message("2")));
  await h.bridge.work();
  h.setMime("application/pdf");
  const e = event("2.000001", "", [{ id: "fixture-file" }]);
  e.event.ts = "200.000001";
  h.bridge.event(e);
  h.ready();
  await h.bridge.work();
  assert.match(
    h.calls.find((x) => x.path.endsWith("sendmessage"))!.body.msg.item_list[0]
      .text_item.text,
    /仅支持/,
  );
});
test("发送 500 结果不确定，重启后不盲重试；准备阶段网络失败可重试", async (t) => {
  const h = await setup(t);
  h.failures.set("/api/chat.postMessage", { status: 500, count: 1 });
  h.bridge.ingest(batch(message()));
  await h.bridge.work();
  h.restart();
  await h.bridge.work();
  assert.equal(
    h.calls.filter((x) => x.path.endsWith("chat.postMessage")).length,
    1,
  );
  assert.equal(h.store.get("SELECT status FROM jobs").status, "uncertain");
});
test("媒体大小和私网地址拒绝，过期上下文不发送", async (t) => {
  const h = await setup(t);
  h.c.maxFileBytes = 10;
  await assert.rejects(h.slack.download({ id: "fixture-file" }), /超过限额/);
  h.c.maxFileBytes = 1024;
  h.setUrl("https://127.0.0.1/secret");
  await assert.rejects(h.slack.download({ id: "fixture-file" }), /白名单/);
  h.bridge.ingest(batch(message()));
  await h.bridge.work();
  h.store.run(
    "UPDATE inbound SET created=?",
    Date.now() - h.c.contextTtlMs - 1,
  );
  h.bridge.event(event());
  h.ready();
  await h.bridge.work();
  assert.equal(h.calls.filter((x) => x.path.endsWith("sendmessage")).length, 0);
});
test("扫码绑定身份保存，凭据不会出现在二维码输出", async (t) => {
  const h = await setup(t);
  const displayed: string[] = [];
  await login(
    h.c,
    h.http,
    (s) => displayed.push(s),
    async () => "123456",
    async () => {},
  );
  assert.deepEqual(displayed, ["fixture-qr-content"]);
  assert.equal(
    sessionSchema.parse(
      JSON.parse(readFileSync(join(h.c.stateDir, "session.json"), "utf8")),
    ).ilink_user_id,
    session.ilink_user_id,
  );
});
test("最终文字后独立图片消息仍可投递，重复文件只送一次", async (t) => {
  const h = await setup(t);
  h.bridge.ingest(batch(message()));
  await h.bridge.work();
  h.bridge.event(event());
  h.ready();
  await h.bridge.work();
  const file = event("1.000001", "", [{ id: "fixture-file" }]);
  file.event.ts = "106.000001";
  file.event.subtype = "file_share";
  h.bridge.event(file);
  h.ready();
  await h.bridge.work();
  file.event.ts = "107.000001";
  h.bridge.event(file);
  h.ready();
  await h.bridge.work();
  assert.equal(h.calls.filter((x) => x.path.endsWith("sendmessage")).length, 2);
});
test("图片准备失败安全重试，完成前不发就绪事件", async (t) => {
  const h = await setup(t);
  h.failures.set("/c2c/download", { status: 500, count: 1 });
  h.bridge.ingest(
    batch(
      message("1", [
        {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: "fixture",
              aes_key: key.toString("base64"),
            },
          },
        },
      ]),
    ),
  );
  await h.bridge.work();
  assert.equal(
    h.calls.filter((x) => x.path.endsWith("chat.postMessage")).length,
    1,
  );
  h.ready();
  await h.bridge.work();
  const posts = h.calls.filter((x) => x.path.endsWith("chat.postMessage"));
  assert.equal(posts.length, 2);
  assert.match(posts[1]!.body.text, /消息就绪/);
  assert.equal(posts[1]!.body.thread_ts, "1.000001");
  assert.equal(
    h.store.get("SELECT source_ts FROM inbound").source_ts,
    "2.000001",
  );
});
test("崩溃中的发送恢复为不确定；TTL 清正文但保留墓碑", async (t) => {
  const h = await setup(t);
  h.bridge.ingest(batch(message()));
  h.store.run("UPDATE jobs SET status='sending'");
  h.restart();
  await h.bridge.work();
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.get("SELECT status FROM jobs").status, "uncertain");
  h.store.run("UPDATE jobs SET created=0");
  h.store.run("UPDATE inbound SET created=0");
  h.store.cleanup();
  assert.equal(h.store.get("SELECT context FROM inbound").context, "");
  assert.equal(h.store.get("SELECT payload FROM jobs").payload, "{}");
  h.bridge.ingest(batch(message()));
  await h.bridge.work();
  assert.equal(h.calls.length, 0);
});
test("状态账号隔离与容量限制失败关闭", async (t) => {
  const h = await setup(t);
  assert.throws(
    () =>
      new Bridge(
        h.c,
        h.store,
        new Weixin(h.c, { ...session, ilink_user_id: "fixture-other" }, h.http),
        h.slack,
      ),
    /另一微信账号/,
  );
  h.c.maxStateBytes = 1;
  assert.throws(() => h.bridge.ingest(batch(message())), /容量/);
  assert.equal(h.store.meta("cursor"), "");
});

test("Socket Mode 假服务发送正式事件封套，持久保存后 ACK 并回微信", async (t) => {
  const { SocketModeClient } = await import("@slack/socket-mode");
  const { WebSocketServer } = await import("ws");
  const h = await setup(t);
  h.bridge.ingest(batch(message()));
  await h.bridge.work();
  let port = 0;
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${port}/socket` }));
  });
  const wss = new WebSocketServer({ server, path: "/socket" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    setLevel() {},
    setName() {},
    getLevel() {
      return "error" as any;
    },
  };
  const socket = new SocketModeClient({
    appToken: "fixture-socket-token",
    logger,
    autoReconnectEnabled: false,
    clientOptions: {
      slackApiUrl: `http://127.0.0.1:${port}/api/`,
      retryConfig: { retries: 0 },
    },
  });
  t.after(async () => {
    await socket.disconnect();
    wss.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const acked = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("测试事件确认超时")), 3000);
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "hello" }));
      ws.send(
        JSON.stringify({
          type: "events_api",
          envelope_id: "fixture-envelope",
          payload: event(),
        }),
      );
      ws.on("message", (raw) => {
        const ack = JSON.parse(raw.toString());
        if (ack.envelope_id === "fixture-envelope") {
          clearTimeout(timer);
          assert.equal(h.store.get("SELECT count(*) AS n FROM events").n, 1);
          resolve();
        }
      });
    });
  });
  socket.on("slack_event", async ({ body, ack }: any) => {
    h.bridge.event(body);
    await ack();
  });
  await socket.start();
  await acked;
  h.ready();
  await h.bridge.work();
  assert.equal(h.calls.filter((x) => x.path.endsWith("sendmessage")).length, 1);
});

for (const path of ["/api/files.getUploadURLExternal", "/upload/test"]) {
  for (const status of [500, 0]) {
    test(`图片发布前 ${path} ${status === 0 ? "断网" : "服务端错误"} 安全重试`, async (t) => {
      const h = await setup(t);
      h.failures.set(path, { status, count: 1 });
      h.bridge.ingest(
        batch(
          message("1", [
            {
              type: 2,
              image_item: {
                media: {
                  encrypt_query_param: "fixture",
                  aes_key: key.toString("base64"),
                },
              },
            },
          ]),
        ),
      );
      await h.bridge.work();
      assert.equal(
        h.store.get("SELECT status FROM jobs WHERE kind='slackImage'").status,
        "pending",
      );
      assert.equal(
        h.calls.filter((x) => x.path.endsWith("files.completeUploadExternal"))
          .length,
        0,
      );
      h.restart();
      h.ready();
      await h.bridge.work();
      assert.equal(
        h.store.get("SELECT status FROM jobs WHERE kind='slackImage'").status,
        "done",
      );
      assert.equal(
        h.calls.filter((x) => x.path.endsWith("files.completeUploadExternal"))
          .length,
        1,
      );
      assert.equal(
        h.calls.filter((x) => x.path.endsWith("chat.postMessage")).length,
        2,
      );
    });
  }
}

test("图片完成发布接口结果不确定时仍禁止重试", async (t) => {
  const h = await setup(t);
  h.failures.set("/api/files.completeUploadExternal", {
    status: 500,
    count: 1,
  });
  h.bridge.ingest(
    batch(
      message("1", [
        {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: "fixture",
              aes_key: key.toString("base64"),
            },
          },
        },
      ]),
    ),
  );
  await h.bridge.work();
  h.restart();
  h.ready();
  await h.bridge.work();
  assert.equal(
    h.store.get("SELECT status FROM jobs WHERE kind='slackImage'").status,
    "uncertain",
  );
  assert.equal(
    h.calls.filter((x) => x.path.endsWith("files.completeUploadExternal"))
      .length,
    1,
  );
  assert.equal(
    h.calls.filter((x) => x.path.endsWith("chat.postMessage")).length,
    1,
  );
});

test("超过 TTL 后重启先清理，根消息和图片不得发送", async (t) => {
  const h = await setup(t);
  h.bridge.ingest(
    batch(
      message("1", [
        { type: 1, text_item: { text: "过期文字" } },
        {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: "fixture",
              aes_key: key.toString("base64"),
            },
          },
        },
      ]),
    ),
  );
  h.store.run("UPDATE jobs SET created=0");
  h.store.run("UPDATE inbound SET created=0");
  h.restart();
  assert.equal(
    h.store.get("SELECT count(*) AS n FROM jobs WHERE status='pending'").n,
    0,
  );
  await h.bridge.work();
  assert.equal(h.calls.length, 0);
});

test("TTL 小于上下文寿命时，领取前和重启后都拒绝过期回程", async (t) => {
  const h = await setup(t);
  h.c.ttlMs = 60000;
  h.c.contextTtlMs = 3600000;
  h.bridge.ingest(batch(message()));
  await h.bridge.work();
  h.bridge.event(event());
  h.ready();
  h.bridge.route();
  h.store.run("UPDATE inbound SET created=?", Date.now() - 60001);
  await h.bridge.work();
  assert.equal(
    h.store.get("SELECT status FROM jobs WHERE kind='wxText'").status,
    "failed",
  );
  h.restart();
  await h.bridge.work();
  assert.equal(h.calls.filter((x) => x.path.endsWith("sendmessage")).length, 0);
});

test("首次启用隔离历史文本和图片，确认后混合批次的新图片按原始字节投递", async (t) => {
  const h = await setup(t, false);
  const base = Date.now() - 1000;
  const picture = {
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: "fixture",
        aes_key: key.toString("base64"),
      },
    },
  };
  const dated = (id: string, at: number, items?: any[]) => ({
    ...message(id, items),
    create_time_ms: at,
  });
  h.setUpdates(batch(dated("1", base, [picture]), dated("2", base)));
  h.bridge.ingest(await h.wx.updates(""));
  await h.bridge.work();
  assert.equal(h.store.all("SELECT * FROM jobs").length, 0);
  assert.deepEqual(
    h.calls.map((x) => x.path),
    ["/ilink/bot/getupdates"],
  );
  h.setUpdates(
    batch(
      dated("3", base + 200, [
        { type: 1, text_item: { text: h.bridge.activationCommand } },
      ]),
      dated("4", base + 199, [picture]),
      dated("5", base + 201, [
        { type: 1, text_item: { text: "启用后的文字" } },
        picture,
      ]),
    ),
  );
  h.bridge.ingest(await h.wx.updates(h.store.meta("cursor")));
  await h.bridge.work();
  assert.equal(h.store.all("SELECT * FROM inbound").length, 1);
  assert.equal(
    digest(h.calls.find((x) => x.path === "/upload/test")!.bytes),
    digest(png),
  );
  assert.match(
    h.calls.find((x) => x.path.endsWith("chat.postMessage"))!.body.text,
    /启用后的文字/,
  );
  assert.equal(h.calls.filter((x) => x.path === "/c2c/download").length, 1);
});

test("启用确认乱序和重启保留缓冲及边界，不丢随后消息且不重放历史", async (t) => {
  const h = await setup(t, false);
  const boundary = Date.now() - 1000;
  const command = h.bridge.activationCommand;
  const newer = { ...message("10"), create_time_ms: boundary + 1 };
  h.setUpdates(batch(newer));
  h.bridge.ingest(await h.wx.updates(""));
  h.restart();
  assert.equal(h.bridge.activationCommand, command);
  assert.equal(h.bridge.activated, false);
  h.setUpdates(
    batch({
      ...message("11", [{ type: 1, text_item: { text: command } }]),
      create_time_ms: boundary,
    }),
  );
  h.bridge.ingest(await h.wx.updates(h.store.meta("cursor")));
  await h.bridge.work();
  assert.equal(h.store.all("SELECT * FROM inbound").length, 1);
  h.restart();
  assert.equal(h.store.meta("activation_boundary"), String(boundary));
  h.setUpdates(
    batch(
      newer,
      { ...message("12"), create_time_ms: boundary - 1 },
      { ...message("13"), create_time_ms: boundary + 2 },
    ),
  );
  h.bridge.ingest(await h.wx.updates(h.store.meta("cursor")));
  await h.bridge.work();
  assert.equal(
    h.calls.filter((x) => x.path.endsWith("chat.postMessage")).length,
    2,
  );
  assert.equal(h.store.all("SELECT * FROM activation_buffer").length, 0);
});

test("缺失非法时间和非主人确认均失败关闭，边界同毫秒不猜先后", async (t) => {
  const h = await setup(t, false);
  const base = Date.now() - 1000;
  const confirmation = {
    ...message("20", [
      { type: 1, text_item: { text: h.bridge.activationCommand } },
    ]),
    create_time_ms: base,
  };
  h.bridge.ingest(
    batch(
      { ...confirmation, from_user_id: "fixture-stranger" },
      { ...confirmation, create_time_ms: undefined },
    ),
  );
  assert.equal(h.bridge.activated, false);
  h.bridge.ingest(batch(confirmation));
  for (const time of [
    undefined,
    null,
    "1700000000000",
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    base,
  ]) {
    h.setUpdates(batch({ ...message("21"), create_time_ms: time }));
    h.bridge.ingest(await h.wx.updates(h.store.meta("cursor")));
  }
  await h.bridge.work();
  assert.equal(h.store.all("SELECT * FROM jobs").length, 0);
  assert.equal(
    h.calls.some((x) => x.path.endsWith("chat.postMessage")),
    false,
  );
});

test("异常未来时间不推进游标，修正后可重试；五分钟容差不放宽历史边界", async (t) => {
  const h = await setup(t, false);
  const now = Date.now();
  const confirmation = message("30", [
    { type: 1, text_item: { text: h.bridge.activationCommand } },
  ]);
  h.bridge.ingest({
    msgs: [{ ...confirmation, create_time_ms: now + 10000 }],
    get_updates_buf: "before",
  });
  h.setUpdates({
    msgs: [{ ...message("31"), create_time_ms: now + 600000 }],
    get_updates_buf: "after",
  });
  assert.throws(
    () =>
      h.bridge.ingest({
        msgs: [{ ...message("31"), create_time_ms: now + 600000 }],
        get_updates_buf: "after",
      }),
    /时间异常/,
  );
  assert.equal(h.store.meta("cursor"), "before");
  h.setUpdates(
    batch(
      { ...message("32"), create_time_ms: now + 9999 },
      { ...message("31"), create_time_ms: now + 10001 },
    ),
  );
  h.bridge.ingest(await h.wx.updates("before"));
  await h.bridge.work();
  assert.equal(h.store.all("SELECT * FROM inbound").length, 1);
  h.store.set("activation_boundary", String(now + 600000));
  assert.throws(() => h.bridge.ingest(batch(message("33"))), /本机时钟异常/);
});

test("旧版本状态升级必须确认，旧待发送内容不会随启用泄漏", async (t) => {
  const h = await setup(t);
  h.bridge.ingest(batch(message("40")));
  h.store.run(
    "DELETE FROM meta WHERE k IN ('activation_challenge','activation_boundary')",
  );
  h.restart();
  assert.equal(h.bridge.activated, false);
  await h.bridge.work();
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.get("SELECT status FROM jobs").status, "failed");
  assert.equal(h.store.get("SELECT context FROM inbound").context, "");
  assert.equal(h.store.get("SELECT payload FROM jobs").payload, "{}");
});
