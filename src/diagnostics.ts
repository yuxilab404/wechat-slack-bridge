import { Fault } from "./http.js";
const slackCodes = new Set([
  "invalid_arguments",
  "invalid_arg_name",
  "invalid_array_arg",
  "invalid_form_data",
  "invalid_post_type",
  "missing_argument",
  "invalid_auth",
  "not_authed",
  "token_expired",
  "token_revoked",
  "missing_scope",
  "no_permission",
  "file_uploads_disabled",
  "file_upload_size_restricted",
  "file_type_not_allowed",
  "ratelimited",
  "internal_error",
  "fatal_error",
  "request_timeout",
  "service_unavailable",
]);
export function slackErrorCode(value: unknown): string {
  return typeof value === "string" && slackCodes.has(value)
    ? value
    : "未识别错误";
}
const stages = new Set(["申请上传地址", "上传图片字节", "完成图片发布"]);
const localCodes = new Set([
  "网络请求失败",
  "接口请求失败",
  "接口限流",
  "接口响应格式无效",
  "Slack 文件准备结果不完整",
  "地址无效",
  "地址不在安全白名单",
  "拒绝重定向",
  "媒体或响应超过限额",
]);
// 仅白名单阶段和错误码可进入日志，绝不输出 Error、响应体、URL 或身份。
export function reportUploadFailure(
  fault: Fault,
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): string {
  if (!stages.has(fault.stage)) return "";
  const code = fault.apiCode
    ? slackErrorCode(fault.apiCode)
    : localCodes.has(fault.code)
      ? fault.code
      : "未识别错误";
  const message = `Slack 图片处理失败；阶段：${fault.stage}；错误码：${code}`;
  write(message + "\n");
  return message;
}

export const slackEventReasons = [
  "收到",
  "团队不匹配",
  "频道不匹配",
  "非消息事件",
  "作者不匹配",
  "应用不匹配",
  "身份映射未验证",
  "消息类型不支持",
  "消息格式无效",
  "重复或过时",
  "已接收",
  "已补核文件身份",
] as const;
export type SlackEventReason = (typeof slackEventReasons)[number];
export function reportSlackEvent(
  reason: SlackEventReason,
  total: number,
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
) {
  if (
    !slackEventReasons.includes(reason) ||
    !Number.isSafeInteger(total) ||
    total < 1
  )
    return;
  write(`Slack 事件统计；类别：${reason}；累计：${total}\n`);
}
