import { z } from "zod";
import { readFileSync, statSync } from "node:fs";
const id = z.string().min(1).max(256);
export const schema = z
  .object({
    team: id,
    channel: id,
    dotUser: id,
    dotBot: id,
    dotApp: id,
    bridgeUser: id,
    stateDir: z.string().default("./state"),
    secretFile: z.string(),
    apiHosts: z
      .array(z.string().regex(/^[a-z0-9.-]+$/))
      .min(1)
      .default(["ilinkai.weixin.qq.com"]),
    mediaHosts: z
      .array(z.string().regex(/^[a-z0-9.-]+$/))
      .min(1)
      .default(["novac2c.cdn.weixin.qq.com", "files.slack.com"]),
    maxFileBytes: z
      .number()
      .int()
      .min(1024)
      .max(20 * 1024 * 1024)
      .default(10 * 1024 * 1024),
    maxStateBytes: z
      .number()
      .int()
      .min(1048576)
      .max(1024 * 1024 * 1024)
      .default(100 * 1024 * 1024),
    ttlMs: z
      .number()
      .int()
      .min(60000)
      .max(7 * 86400000)
      .default(86400000),
    contextTtlMs: z.number().int().min(1000).max(86400000).default(3600000),
    settleMs: z.number().int().min(1000).max(60000).default(5000),
    finalPrefix: z.string().min(1).default("【最终回复】"),
  })
  .strict()
  .refine((c) => c.dotUser !== c.bridgeUser, "桥与回复者不能相同");
export type Config = z.infer<typeof schema>;
const credential = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);
export const secretsSchema = z
  .object({ slackBotToken: credential, slackAppToken: credential })
  .strict();
export const sessionSchema = z
  .object({
    bot_token: credential,
    ilink_bot_id: id,
    ilink_user_id: id,
    baseurl: z.string().url(),
  })
  .strict();
export type Session = z.infer<typeof sessionSchema>;
export function privateJson(file: string): unknown {
  const st = statSync(file);
  if (!st.isFile() || (st.mode & 0o077) !== 0)
    throw new Error("凭据文件必须仅属主可读写");
  return JSON.parse(readFileSync(file, "utf8"));
}
export function config(file: string): Config {
  try {
    return schema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error("配置无效，请核对中文配置文档");
  }
}
