import { randomBytes, createHash } from "node:crypto";
import type { Config, Session } from "./config.js";
import { Http, Fault, checkUrl } from "./http.js";
import { aesKey, decrypt, encrypt, imageType } from "./media.js";
import { slackErrorCode } from "./diagnostics.js";
export class Weixin {
  constructor(
    public c: Config,
    public session: Session,
    public http = new Http(),
  ) {
    checkUrl(session.baseurl, c.apiHosts);
  }
  async api(method: string, body: unknown): Promise<any> {
    const r = await this.http.json(
      new URL(`/ilink/bot/${method}`, this.session.baseurl).href,
      this.c.apiHosts,
      {
        Authorization: `Bearer ${this.session.bot_token}`,
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": Buffer.from(
          String(randomBytes(4).readUInt32BE()),
        ).toString("base64"),
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": String(0x020409),
      },
      {
        ...(body as object),
        base_info: {
          channel_version: "2.4.9",
          bot_agent: "WechatSlackBridge/0.1.0",
        },
      },
    );
    if (r.ret === -14 || r.errcode === -14)
      throw new Fault("微信会话已过期", 3600000);
    if ((r.ret ?? 0) !== 0 || (r.errcode ?? 0) !== 0)
      throw new Fault("微信拒绝请求");
    return r;
  }
  updates(cursor: string) {
    return this.api("getupdates", { get_updates_buf: cursor });
  }
  async download(item: any): Promise<Buffer> {
    const m = item.media;
    if (!m) throw new Fault("图片缺少媒体信息");
    const url =
      m.full_url ||
      `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(m.encrypt_query_param ?? "")}`;
    const r = await this.http.bytes(
      url,
      this.c.mediaHosts,
      "GET",
      {},
      undefined,
      this.c.maxFileBytes + 16,
    );
    const b =
      item.aeskey || m.aes_key
        ? decrypt(r.bytes, aesKey(m.aes_key ?? "", item.aeskey))
        : r.bytes;
    if (b.length > this.c.maxFileBytes) throw new Fault("媒体或响应超过限额");
    imageType(b);
    return b;
  }
  async upload(bytes: Buffer, user: string): Promise<any> {
    imageType(bytes);
    if (bytes.length > this.c.maxFileBytes)
      throw new Fault("媒体或响应超过限额");
    const key = randomBytes(16),
      filekey = randomBytes(16).toString("hex"),
      encrypted = encrypt(bytes, key);
    const r = await this.api("getuploadurl", {
      filekey,
      media_type: 1,
      to_user_id: user,
      rawsize: bytes.length,
      rawfilemd5: createHash("md5").update(bytes).digest("hex"),
      filesize: encrypted.length,
      no_need_thumb: true,
      aeskey: key.toString("hex"),
    });
    if (!r.upload_full_url && !r.upload_param)
      throw new Fault("微信未返回上传地址");
    const url =
      r.upload_full_url ||
      `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(r.upload_param)}&filekey=${filekey}`;
    const response = await this.http.bytes(
      url,
      this.c.mediaHosts,
      "POST",
      { "Content-Type": "application/octet-stream" },
      encrypted,
    );
    const param = response.headers.get("x-encrypted-param");
    if (!param) throw new Fault("微信上传结果不完整");
    return {
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: param,
          aes_key: Buffer.from(key.toString("hex")).toString("base64"),
          encrypt_type: 1,
        },
        mid_size: encrypted.length,
      },
    };
  }
  send(user: string, context: string, clientId: string, item: any) {
    if (!context) throw new Fault("缺少微信上下文，等待新消息");
    return this.api("sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: user,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: context,
        item_list: [item],
      },
    });
  }
}
export class Slack {
  constructor(
    public c: Config,
    private token: string,
    public http = new Http(),
  ) {}
  async api(method: string, body: unknown): Promise<any> {
    const r = await this.http.json(
      `https://slack.com/api/${method}`,
      ["slack.com"],
      { Authorization: `Bearer ${this.token}` },
      body,
    );
    if (!r.ok)
      throw new Fault(
        "Slack 拒绝请求",
        0,
        [
          "internal_error",
          "fatal_error",
          "request_timeout",
          "service_unavailable",
        ].includes(r.error),
        "",
        slackErrorCode(r.error),
      );
    return r;
  }
  async post(text: string, thread?: string): Promise<string> {
    const r = await this.api("chat.postMessage", {
      channel: this.c.channel,
      text,
      thread_ts: thread,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (typeof r.ts !== "string")
      throw new Fault("Slack 发送结果不完整", 0, true);
    return r.ts;
  }
  private async uploadStage<T>(
    stage: string,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (e) {
      const f = e instanceof Fault ? e : new Fault("处理失败");
      f.stage = stage;
      throw f;
    }
  }
  async prepareUpload(bytes: Buffer): Promise<string> {
    const ext = imageType(bytes);
    const r = await this.uploadStage("申请上传地址", async () => {
      const result = await this.api(
        "files.getUploadURLExternal",
        new URLSearchParams({
          filename: `图片.${ext}`,
          length: String(bytes.length),
        }),
      );
      if (
        typeof result.file_id !== "string" ||
        !result.file_id ||
        typeof result.upload_url !== "string"
      )
        throw new Fault("Slack 文件准备结果不完整", 0, true);
      return result;
    });
    await this.uploadStage("上传图片字节", () =>
      this.http.bytes(
        r.upload_url,
        this.c.mediaHosts,
        "POST",
        { "Content-Type": "application/octet-stream" },
        bytes,
      ),
    );
    return r.file_id;
  }
  async publishUpload(fileId: string, thread: string): Promise<void> {
    await this.uploadStage("完成图片发布", () =>
      this.api(
        "files.completeUploadExternal",
        new URLSearchParams({
          files: JSON.stringify([{ id: fileId, title: "微信图片" }]),
          channel_id: this.c.channel,
          thread_ts: thread,
        }),
      ),
    );
  }
  async download(file: any): Promise<Buffer> {
    if (!file.id) throw new Fault("Slack 文件缺少标识");
    const info = await this.api("files.info", { file: file.id });
    const f = info.file;
    if (!f || !/^image\/(png|jpeg|gif|webp)$/.test(f.mimetype ?? ""))
      throw new Fault("仅支持 PNG、JPEG、GIF、WebP 图片");
    if (f.size > this.c.maxFileBytes) throw new Fault("媒体或响应超过限额");
    const bytes = (
      await this.http.bytes(
        f.url_private_download || f.url_private,
        ["files.slack.com"],
        "GET",
        { Authorization: `Bearer ${this.token}` },
        undefined,
        this.c.maxFileBytes,
      )
    ).bytes;
    imageType(bytes);
    return bytes;
  }
}
