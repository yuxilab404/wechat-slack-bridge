// AES 算法改编自 Tencent/openclaw-weixin；许可及固定版本见 third_party/来源.md。
import { createCipheriv, createDecipheriv } from "node:crypto";
import { Fault } from "./http.js";
export function encrypt(bytes: Buffer, key: Buffer): Buffer {
  const c = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([c.update(bytes), c.final()]);
}
export function decrypt(bytes: Buffer, key: Buffer): Buffer {
  try {
    const c = createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([c.update(bytes), c.final()]);
  } catch {
    throw new Fault("图片解密失败");
  }
}
export function aesKey(base64: string, hex?: string): Buffer {
  const raw = hex ? Buffer.from(hex, "hex") : Buffer.from(base64, "base64");
  if (hex && !/^[a-f0-9]{32}$/i.test(hex)) throw new Fault("图片密钥格式无效");
  if (raw.length === 16) return raw;
  if (raw.length === 32 && /^[a-f0-9]{32}$/i.test(raw.toString()))
    return Buffer.from(raw.toString(), "hex");
  throw new Fault("图片密钥格式无效");
}
export function imageType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "png";
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "jpg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString()))
    return "gif";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "webp";
  throw new Fault("仅支持 PNG、JPEG、GIF、WebP 图片");
}
