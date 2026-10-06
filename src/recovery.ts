import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { Config } from "./config.js";
import { Fault } from "./http.js";

// 仅用于人工确认发布接口从未调用的单条准备失败任务；不依据旧版通用错误自动推断阶段。
export async function retryFailedSlackImage(
  c: Config,
  jobId: string,
  root: string,
  confirmedPrepareFailure: boolean,
) {
  if (!confirmedPrepareFailure)
    throw new Fault("必须先独立确认该任务仅在准备阶段失败");
  const release = await lockfile.lock(c.stateDir, {
    realpath: true,
    lockfilePath: join(c.stateDir, "runtime.lock"),
    stale: 120000,
    update: 10000,
  });
  let db: DatabaseSync | undefined;
  try {
    const path = join(c.stateDir, "bridge.sqlite");
    if (!statSync(path).isFile()) throw new Fault("状态数据库不存在");
    db = new DatabaseSync(path);
    db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    try {
      const result = db
        .prepare(
          `UPDATE jobs SET status='pending',due=0,error=NULL
        WHERE id=? AND kind='slackImage' AND status='failed' AND payload!='{}' AND created>?
        AND error IN ('Slack 拒绝请求','Slack 图片处理失败；阶段：申请上传地址；错误码：invalid_arguments')
        AND source IN (SELECT id FROM inbound WHERE root=? AND created>?)
        AND EXISTS (SELECT 1 FROM jobs AS other WHERE other.source=jobs.source AND other.kind='root' AND other.status='done')
        AND EXISTS (SELECT 1 FROM jobs AS other WHERE other.source=jobs.source AND other.kind='ready' AND other.status='pending')
        AND NOT EXISTS (SELECT 1 FROM jobs AS other WHERE other.source=jobs.source AND other.status IN ('sending','uncertain'))
      `,
        )
        .run(jobId, Date.now() - c.ttlMs, root, Date.now() - c.ttlMs);
      if (result.changes !== 1)
        throw new Fault("单条恢复条件不满足，未修改任何任务");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db?.close();
    await release();
  }
}

// 回程恢复另行核实 files.info 确定拒绝，禁止重写来源上下文或延长有效期。
export async function retryFailedWeixinImage(
  c: Config,
  jobId: string,
  root: string,
  confirmedFilesInfoFailure: boolean,
) {
  if (!confirmedFilesInfoFailure)
    throw new Fault("必须先独立确认该任务仅在文件信息查询阶段失败");
  const release = await lockfile.lock(c.stateDir, {
    realpath: true,
    lockfilePath: join(c.stateDir, "runtime.lock"),
    stale: 120000,
    update: 10000,
  });
  let db: DatabaseSync | undefined;
  try {
    const path = join(c.stateDir, "bridge.sqlite");
    if (!statSync(path).isFile()) throw new Fault("状态数据库不存在");
    db = new DatabaseSync(path);
    db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    try {
      const result = db
        .prepare(
          `UPDATE jobs SET status='pending',due=0,error=NULL
        WHERE id=? AND kind='wxImage' AND status='failed' AND payload!='{}' AND created>?
        AND error IN ('Slack 拒绝请求','Slack 图片处理失败；阶段：查询回程文件信息；错误码：invalid_arguments')
        AND source IN (SELECT id FROM inbound WHERE root=? AND created>? AND context!='')
        AND EXISTS (SELECT 1 FROM jobs AS other WHERE other.source=jobs.source AND other.kind='root' AND other.status='done')
        AND NOT EXISTS (SELECT 1 FROM jobs AS other WHERE other.source=jobs.source AND other.status IN ('sending','uncertain'))
      `,
        )
        .run(
          jobId,
          Date.now() - c.ttlMs,
          root,
          Date.now() - Math.min(c.ttlMs, c.contextTtlMs),
        );
      if (result.changes !== 1)
        throw new Fault("单条恢复条件不满足，未修改任何任务");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db?.close();
    await release();
  }
}
