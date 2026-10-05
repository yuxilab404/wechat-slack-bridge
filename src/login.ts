import {
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import qr from "qrcode-terminal";
import { Http, Fault, checkUrl } from "./http.js";
import { sessionSchema, type Config, type Session } from "./config.js";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function saveSession(c: Config, s: Session) {
  mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  const temp = join(
    c.stateDir,
    `session-${randomBytes(8).toString("hex")}.tmp`,
  );
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(s));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, join(c.stateDir, "session.json"));
  const dir = openSync(c.stateDir, "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
export async function login(
  c: Config,
  http = new Http(),
  display: (s: string) => void = (s) => qr.generate(s, { small: true }),
  verify: () => Promise<string> = async () => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await rl.question("请输入微信显示的验证码：");
    } finally {
      rl.close();
    }
  },
  wait = pause,
): Promise<void> {
  const headers = {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(0x020409),
  };
  for (let refresh = 0; refresh < 3; refresh++) {
    let base = "https://ilinkai.weixin.qq.com";
    let code = "";
    const q = await http.json(
      `${base}/ilink/bot/get_bot_qrcode?bot_type=3`,
      c.apiHosts,
      {
        ...headers,
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": Buffer.from(
          String(randomBytes(4).readUInt32BE()),
        ).toString("base64"),
      },
      { local_token_list: [] },
    );
    if (
      typeof q.qrcode !== "string" ||
      typeof q.qrcode_img_content !== "string"
    )
      throw new Fault("二维码响应无效");
    display(q.qrcode_img_content);
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      const r = await http.json(
        `${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(q.qrcode)}${code ? `&verify_code=${encodeURIComponent(code)}` : ""}`,
        c.apiHosts,
        headers,
      );
      if (r.status === "confirmed") {
        let s: Session;
        try {
          s = sessionSchema.parse({
            bot_token: r.bot_token,
            ilink_bot_id: r.ilink_bot_id,
            ilink_user_id: r.ilink_user_id,
            baseurl: r.baseurl,
          });
        } catch {
          throw new Fault("登录结果不完整");
        }
        checkUrl(s.baseurl, c.apiHosts);
        saveSession(c, s);
        return;
      }
      if (r.status === "expired") break;
      if (r.status === "need_verifycode") {
        code = await verify();
        if (!/^\d{4,12}$/.test(code)) throw new Fault("验证码格式无效");
      } else if (r.status === "scaned_but_redirect") {
        base = `https://${r.redirect_host}`;
        checkUrl(base, c.apiHosts);
      } else if (r.status === "verify_code_blocked")
        throw new Fault("验证码已锁定，请稍后重新登录");
      else if (r.status === "binded_redirect")
        throw new Fault("微信已绑定其他实例，请先解除旧绑定");
      else if (!["wait", "scaned"].includes(r.status))
        throw new Fault("未知扫码状态");
      await wait(1000);
    }
  }
  throw new Fault("扫码已过期，请重新登录");
}
