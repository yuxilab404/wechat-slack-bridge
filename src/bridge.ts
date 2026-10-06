import { createHash, randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import { Store } from "./store.js";
import { Slack, Weixin } from "./adapters.js";
import { Fault } from "./http.js";
import { reportUploadFailure } from "./diagnostics.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class Bridge {
  constructor(
    public c: Config,
    public store: Store,
    public wx: Weixin,
    public slack: Slack,
  ) {
    const account = JSON.stringify([
      wx.session.ilink_bot_id,
      wx.session.ilink_user_id,
    ]);
    if (store.meta("account") && store.meta("account") !== account)
      throw new Fault("状态目录属于另一微信账号，请使用新目录");
    store.set("account", account);
    const savedBoundary = store.meta("activation_boundary");
    if (
      savedBoundary &&
      (!Number.isSafeInteger(Number(savedBoundary)) ||
        Number(savedBoundary) <= 0)
    )
      throw new Fault("启用边界损坏，拒绝自动恢复");
    if (!store.meta("activation_challenge")) {
      store.transaction(() => {
        store.set("activation_challenge", randomBytes(16).toString("hex"));
        // 旧版本没有可信启用边界，升级时不自动继续旧的待发送任务。
        store.run(
          "UPDATE jobs SET status='failed',payload='{}',error='等待主人重新确认启用' WHERE status='pending'",
        );
        store.run("UPDATE events SET payload='{}'");
        store.run("UPDATE inbound SET context=''");
      });
    }
  }
  ingest(batch: any) {
    this.store.capacity();
    if (
      !Array.isArray(batch.msgs ?? []) ||
      typeof (batch.get_updates_buf ?? "") !== "string"
    )
      throw new Fault("微信更新格式无效");
    this.store.transaction(() => {
      for (const m of this.activationMessages(batch.msgs ?? [])) {
        if (
          m.from_user_id !== this.wx.session.ilink_user_id ||
          m.group_id ||
          m.message_type !== 1 ||
          m.message_state !== 2 ||
          m.to_user_id !== this.wx.session.ilink_bot_id
        )
          continue;
        if (
          !/^[0-9]{1,20}$/.test(String(m.message_id)) ||
          BigInt(m.message_id) > 18446744073709551615n ||
          !Array.isArray(m.item_list) ||
          m.item_list.length > 20
        )
          continue;
        const id = hash(
          JSON.stringify([
            this.wx.session.ilink_bot_id,
            m.from_user_id,
            String(m.message_id),
          ]),
        );
        const changed = this.store.run(
          "INSERT OR IGNORE INTO inbound(id,payload,context,sender,created) VALUES(?,?,?,?,?)",
          id,
          JSON.stringify(m),
          typeof m.context_token === "string" ? m.context_token : "",
          m.from_user_id,
          Date.now(),
        ).changes;
        if (!changed) continue;
        const text = m.item_list
          .filter((i: any) => i.type === 1)
          .map((i: any) => i.text_item?.text ?? "")
          .join("\n");
        const hasImages = m.item_list.some((i: any) => i.type === 2);
        this.store.job(`${id}:root`, id, "root", {
          text: `${hasImages ? "【微信图片准备中】" : "【微信消息就绪】"}\n${text || "微信发来图片或其他内容"}`,
        });
        m.item_list.forEach((item: any, index: number) => {
          if (item.type === 2)
            this.store.job(`${id}:image:${index}`, id, "slackImage", {
              item: item.image_item,
            });
        });
        if (hasImages) this.store.job(`${id}:ready`, id, "ready", {});
        if (m.item_list.some((i: any) => ![1, 2].includes(i.type)))
          this.store.job(`${id}:unsupported`, id, "wxText", {
            text: "暂不支持此微信消息类型，请发送文字或图片。",
          });
      }
      if (batch.get_updates_buf)
        this.store.set("cursor", batch.get_updates_buf);
    });
  }
  get activationCommand() {
    return `启用桥接 ${this.store.meta("activation_challenge")}`;
  }
  get activated() {
    return Boolean(this.store.meta("activation_boundary"));
  }
  private activationMessages(messages: any[]): any[] {
    const now = Date.now();
    const boundary = Number(this.store.meta("activation_boundary"));
    // 五分钟只用于检测异常时钟，绝不将启用边界向过去放宽。
    if (boundary > now + 300000) throw new Fault("本机时钟异常，微信同步暂停");
    const valid = messages.filter(
      (m) =>
        m &&
        m.from_user_id === this.wx.session.ilink_user_id &&
        m.to_user_id === this.wx.session.ilink_bot_id &&
        !m.group_id &&
        m.message_type === 1 &&
        m.message_state === 2 &&
        /^[0-9]{1,20}$/.test(String(m.message_id)) &&
        BigInt(m.message_id) <= 18446744073709551615n &&
        Array.isArray(m.item_list) &&
        m.item_list.length <= 20 &&
        Number.isSafeInteger(m.create_time_ms) &&
        m.create_time_ms > 0,
    );
    if (valid.some((m) => m.create_time_ms > now + 300000))
      throw new Fault("微信消息时间异常，游标未推进");
    const isConfirmation = (m: any) =>
      m.item_list.length === 1 &&
      m.item_list[0].type === 1 &&
      m.item_list[0].text_item?.text === this.activationCommand;
    if (this.activated)
      return valid.filter(
        (m) => m.create_time_ms > boundary && !isConfirmation(m),
      );
    for (const m of valid) {
      this.store.run(
        "INSERT OR IGNORE INTO activation_buffer VALUES(?,?,?)",
        String(m.message_id),
        JSON.stringify(m),
        now,
      );
    }
    const confirmation = valid.find(isConfirmation);
    if (!confirmation) return [];
    this.store.set("activation_boundary", String(confirmation.create_time_ms));
    // 确认消息可能比随后发送的消息更晚到达，不能只看当前批次。
    const buffered = this.store
      .all("SELECT payload FROM activation_buffer")
      .map((row) => JSON.parse(row.payload))
      .filter(
        (m) =>
          m.create_time_ms > confirmation.create_time_ms && !isConfirmation(m),
      );
    this.store.run("DELETE FROM activation_buffer");
    return buffered;
  }
  event(envelope: any) {
    const outer = envelope.event;
    if (
      envelope.team_id !== this.c.team ||
      outer?.type !== "message" ||
      outer.channel !== this.c.channel
    )
      return;
    const changed = outer.subtype === "message_changed";
    const e = changed ? outer.message : outer;
    if (
      !e ||
      e.user !== this.c.dotUser ||
      e.bot_id !== this.c.dotBot ||
      e.app_id !== this.c.dotApp ||
      e.user === this.c.bridgeUser
    )
      return;
    if (e.subtype && !["bot_message", "file_share"].includes(e.subtype)) return;
    if (
      typeof e.ts !== "string" ||
      !/^\d+\.\d+$/.test(e.ts) ||
      typeof e.thread_ts !== "string" ||
      e.ts === e.thread_ts
    )
      return;
    if (typeof e.text !== "undefined" && typeof e.text !== "string") return;
    if (
      e.files !== undefined &&
      (!Array.isArray(e.files) || e.files.length > 10)
    )
      return;
    const id = hash(`${this.c.team}:${this.c.channel}:${e.ts}`);
    const version = e.edited?.ts ?? outer.event_ts ?? e.ts;
    if (typeof version !== "string" || !/^\d+\.\d+$/.test(version)) return;
    this.store.capacity();
    const previous = this.store.get(
      "SELECT version FROM events WHERE id=?",
      id,
    );
    if (previous && compareTs(previous.version, version) >= 0) return;
    this.store.run(
      "INSERT INTO events VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,due=excluded.due,version=excluded.version",
      id,
      JSON.stringify(e),
      Date.now() + this.c.settleMs,
      Date.now(),
      version,
    );
  }
  route() {
    for (const row of this.store.all(
      "SELECT * FROM events WHERE due<=? AND payload!='{}' ORDER BY created",
      Date.now(),
    )) {
      const e = JSON.parse(row.payload);
      const source = this.store.get(
        "SELECT * FROM inbound WHERE root=?",
        e.thread_ts,
      );
      if (!source) continue;
      if (source.created + this.c.ttlMs <= Date.now()) {
        this.store.run("UPDATE events SET payload='{}' WHERE id=?", row.id);
        continue;
      }
      const text = (e.text ?? "").trim();
      // 静默期不能证明流式完成；文字必须带显式最终标记，文件单独消息可无正文。
      if (text && !text.startsWith(this.c.finalPrefix)) continue;
      if (!text && !e.files?.length) continue;
      this.store.transaction(() => {
        const finalText = text.slice(this.c.finalPrefix.length).trim();
        if (!source.final && finalText) {
          this.store.job(`${source.id}:reply:text`, source.id, "wxText", {
            text: finalText,
          });
          this.store.run("UPDATE inbound SET final=1 WHERE id=?", source.id);
        }
        for (const file of e.files ?? []) {
          if (typeof file.id !== "string") continue;
          const count = this.store.get(
            "SELECT count(*) AS n FROM jobs WHERE source=? AND kind='wxImage'",
            source.id,
          ).n;
          if (count >= 10) break;
          this.store.job(
            `${source.id}:reply:image:${hash(file.id)}`,
            source.id,
            "wxImage",
            { file },
          );
        }
        this.store.run("UPDATE events SET payload='{}' WHERE id=?", row.id);
      });
    }
  }
  async work(signal?: AbortSignal) {
    if (!this.activated) return;
    this.store.expirePending();
    this.route();
    for (const job of this.store.all(
      "SELECT * FROM jobs WHERE status='pending' AND due<=? ORDER BY created,rowid",
      Date.now(),
    )) {
      if (signal?.aborted) break;
      const source = this.store.get(
        "SELECT * FROM inbound WHERE id=?",
        job.source,
      );
      const p = JSON.parse(job.payload);
      if (["slackImage", "ready"].includes(job.kind) && !source.root) continue;
      if (
        job.kind === "ready" &&
        this.store.get(
          "SELECT count(*) AS n FROM jobs WHERE source=? AND kind='slackImage' AND status!='done'",
          source.id,
        ).n
      )
        continue;
      try {
        this.ensureFresh(job, source);
        if (
          job.kind.startsWith("wx") &&
          (!source.context || Date.now() - source.created > this.c.contextTtlMs)
        )
          throw new Fault("微信上下文不可用，等待新消息");
        if (job.kind === "root") {
          this.sending(job.id);
          const root = await this.slack.post(p.text);
          this.store.transaction(() => {
            this.store.run(
              "UPDATE inbound SET root=?,source_ts=? WHERE id=?",
              root,
              root,
              source.id,
            );
            this.done(job.id);
          });
        } else if (job.kind === "ready") {
          this.sending(job.id);
          const ts = await this.slack.post(
            "【微信消息就绪】图片已上传，请结合本线程根消息与图片回复。",
            source.root,
          );
          this.store.transaction(() => {
            this.store.run(
              "UPDATE inbound SET source_ts=? WHERE id=?",
              ts,
              source.id,
            );
            this.done(job.id);
          });
        } else if (job.kind === "slackImage") {
          const bytes = await this.wx.download(p.item);
          const fileId = await this.slack.prepareUpload(bytes);
          this.ensureFresh(job, source);
          this.sending(job.id);
          await this.slack.publishUpload(fileId, source.root);
          this.done(job.id);
        } else {
          let item: any;
          if (job.kind === "wxImage") {
            try {
              const bytes = await this.slack.download(p.file);
              item = await this.wx.upload(bytes, source.sender);
            } catch (e) {
              if (
                e instanceof Fault &&
                e.code === "仅支持 PNG、JPEG、GIF、WebP 图片"
              )
                item = {
                  type: 1,
                  text_item: {
                    text: "收到文件，但目前仅支持 PNG、JPEG、GIF、WebP 图片，未转发该文件。",
                  },
                };
              else throw e;
            }
          } else item = { type: 1, text_item: { text: p.text } };
          this.ensureFresh(job, source);
          if (Date.now() - source.created > this.c.contextTtlMs)
            throw new Fault("微信上下文不可用，等待新消息");
          this.sending(job.id);
          await this.wx.send(source.sender, source.context, hash(job.id), item);
          this.done(job.id);
        }
      } catch (e) {
        const f = e instanceof Fault ? e : new Fault("处理失败");
        const diagnostic = reportUploadFailure(f);
        const sending =
          this.store.get("SELECT status FROM jobs WHERE id=?", job.id)
            .status === "sending";
        const retry = f.retryMs > 0 || (!sending && f.uncertain);
        const status = retry
          ? "pending"
          : sending && f.uncertain
            ? "uncertain"
            : "failed";
        this.store.run(
          "UPDATE jobs SET status=?,due=?,error=? WHERE id=?",
          status,
          Date.now() + (f.retryMs || 30000),
          diagnostic || f.code,
          job.id,
        );
        if (
          job.kind.startsWith("wx") &&
          ["微信拒绝请求", "微信会话已过期"].includes(f.code)
        ) {
          this.store.run("UPDATE inbound SET context='' WHERE id=?", source.id);
          this.store.run(
            "UPDATE jobs SET status='failed',error='微信上下文不可用，等待新消息' WHERE source=? AND kind LIKE 'wx%' AND status='pending'",
            source.id,
          );
        }
      }
    }
  }
  ensureFresh(job: any, source: any) {
    if (Math.min(job.created, source.created) + this.c.ttlMs <= Date.now())
      throw new Fault("任务已过期");
  }
  sending(id: string) {
    this.store.run("UPDATE jobs SET status='sending' WHERE id=?", id);
  }
  done(id: string) {
    this.store.run(
      "UPDATE jobs SET status='done',payload='{}',error=NULL WHERE id=?",
      id,
    );
  }
}
export function compareTs(a: string, b: string): number {
  const [as, af = ""] = a.split("."),
    [bs, bf = ""] = b.split(".");
  const left = BigInt(as!) * 1000000n + BigInt(af.padEnd(6, "0"));
  const right = BigInt(bs!) * 1000000n + BigInt(bf.padEnd(6, "0"));
  return left < right ? -1 : left > right ? 1 : 0;
}
