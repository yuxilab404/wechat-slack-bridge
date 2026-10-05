import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { SocketModeClient } from "@slack/socket-mode";
import { config, privateJson, secretsSchema, sessionSchema } from "./config.js";
import { Store } from "./store.js";
import { Bridge } from "./bridge.js";
import { Slack, Weixin } from "./adapters.js";
import { login } from "./login.js";
import { Fault } from "./http.js";
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
async function main() {
  process.umask(0o077);
  const c = config(process.env.BRIDGE_CONFIG ?? "config.local.json");
  const health = join(c.stateDir, "health");
  if (process.argv[2] === "health") {
    const timestamp = Number(readFileSync(health, "utf8"));
    process.exit(Date.now() - timestamp < 120000 ? 0 : 1);
  }
  mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(c.stateDir, {
    realpath: true,
    lockfilePath: join(c.stateDir, "runtime.lock"),
    stale: 120000,
    update: 10000,
  });
  try {
    if (process.argv[2] === "login") {
      if (!process.stdout.isTTY)
        throw new Fault("扫码请使用交互终端，禁止写入日志");
      await login(c);
      console.log("微信登录已安全保存。");
      return;
    }
    const secrets = secretsSchema.parse(privateJson(c.secretFile));
    const session = sessionSchema.parse(
      privateJson(join(c.stateDir, "session.json")),
    );
    const store = new Store(c),
      slack = new Slack(c, secrets.slackBotToken),
      wx = new Weixin(c, session),
      bridge = new Bridge(c, store, wx, slack);
    const auth = await slack.api("auth.test", {});
    if (auth.team_id !== c.team || auth.user_id !== c.bridgeUser)
      throw new Fault("Slack 凭据身份不匹配");
    // SDK 日志可能携带请求体或凭据；只允许固定中文状态输出。
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      setLevel() {},
      getLevel() {
        return "error" as any;
      },
      setName() {},
    };
    const socket = new SocketModeClient({
      appToken: secrets.slackAppToken,
      logger,
      clientOptions: { retryConfig: { retries: 0 } },
    });
    let tasks: Promise<void>[] = [];
    let connected = false,
      lastPoll = Date.now();
    const stop = new AbortController();
    socket.on("connected", () => {
      connected = true;
    });
    socket.on("disconnected", () => {
      connected = false;
    });
    socket.on("error", () => console.error("Slack 连接发生错误。"));
    socket.on("slack_event", async ({ body, ack }: any) => {
      try {
        bridge.event(body);
        await ack();
      } catch {
        console.error("Slack 事件未能持久保存，等待服务端重试。");
      }
    });
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => stop.abort());
    try {
      await socket.start();
      console.log("桥接服务已启动。");
      const polling = async () => {
        let failures = 0;
        while (!stop.signal.aborted) {
          try {
            bridge.ingest(await wx.updates(store.meta("cursor")));
            lastPoll = Date.now();
            failures = 0;
            await wait(250, stop.signal);
          } catch (e) {
            failures++;
            console.error("微信同步暂停，稍后重试。");
            await wait(
              e instanceof Fault && e.retryMs
                ? e.retryMs
                : Math.min(60000, 1000 * 2 ** Math.min(failures, 6)),
              stop.signal,
            );
          }
        }
      };
      const working = async () => {
        let lastCleanup = 0;
        while (!stop.signal.aborted) {
          await bridge.work(stop.signal);
          if (Date.now() - lastCleanup > 60000) {
            store.cleanup();
            lastCleanup = Date.now();
          }
          if (connected && Date.now() - lastPoll < 90000)
            writeFileSync(health, String(Date.now()), { mode: 0o600 });
          await wait(500, stop.signal);
        }
      };
      tasks = [polling(), working()];
      await Promise.all(tasks);
    } finally {
      stop.abort();
      await Promise.allSettled(tasks);
      await socket.disconnect();
      rmSync(health, { force: true });
      store.close();
    }
  } finally {
    await release();
  }
}
main().catch(() => {
  console.error(
    "服务失败，请核对配置、凭据权限与状态容量；详细排查见中文文档。",
  );
  process.exitCode = 1;
});
