import { createHash, randomBytes, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

export const PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 1 << 20
export const MAX_TEXT_CHARS = 8_000
export const SOCKET_DIR = "/tmp/cc-socks"
export const BRIDGE_NAME = "opencode"
const TAG = "cross-session-message"

export type Priority = "now" | "next" | "later"

export interface UserFrameInput {
  msgId?: string
  text: string
  from?: string
  fromName?: string
  sessionId?: string
  priority?: Priority
  wrap?: boolean
}

export function newId(): string {
  return randomUUID()
}

export function peerToken(): string {
  return randomBytes(16).toString("hex")
}

export function socketPathForPid(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("invalid pid")
  return `${SOCKET_DIR}/${pid}.sock`
}

export function inSocketNamespace(socketPath: string): boolean {
  if (!socketPath.startsWith("/") || socketPath.includes("\0")) return false
  const parts = socketPath.split("/")
  // A leading slash yields one empty segment. Any later empty segment is "//".
  if (parts.includes("..") || parts.slice(1).includes("")) return false
  return socketPath.startsWith(`${SOCKET_DIR}/`) || socketPath.startsWith("/private/tmp/cc-socks/")
}

export function toAddress(socketPath: string): string {
  if (!inSocketNamespace(socketPath)) throw new Error("socket is outside the Claude Code inbox namespace")
  let out = "uds:"
  for (const byte of Buffer.from(socketPath)) {
    const ch = String.fromCharCode(byte)
    if (/[A-Za-z0-9:_/.\-]/.test(ch)) out += ch
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
  }
  return out
}

export function parseAddress(addr: string): string {
  if (addr.startsWith("uds:")) return percentDecode(addr.slice(4))
  if (addr.startsWith("/")) return addr
  throw new Error("not a uds address or absolute socket path")
}

function percentDecode(value: string): string {
  const bytes: number[] = []
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "%" && i + 2 < value.length) {
      const hex = value.slice(i + 1, i + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        i += 2
        continue
      }
    }
    bytes.push(value.charCodeAt(i))
  }
  return Buffer.from(bytes).toString("utf8")
}

export function addressSafe(addr: string): boolean {
  if (!addr.startsWith("uds:")) return false
  const rest = addr.slice(4)
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (/[A-Za-z0-9:_/.\-]/.test(ch)) continue
    if (ch !== "%" || !/^[0-9A-Fa-f]{2}$/.test(rest.slice(i + 1, i + 3))) return false
    i += 2
  }
  return inSocketNamespace(parseAddress(addr))
}

// Go's %q for the characters we put in attributes. The receiver re-serializes
// the envelope and drops it when spacing or escapes differ.
export function goQuote(value: string): string {
  let out = '"'
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if (ch === "\\" || ch === '"') out += `\\${ch}`
    else if (ch === "\n") out += "\\n"
    else if (ch === "\r") out += "\\r"
    else if (ch === "\t") out += "\\t"
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`
    else out += ch
  }
  return `${out}"`
}

export function sanitizeName(name: string): string {
  const cleaned = [...name].filter((ch) => {
    if ('"<>\r\n'.includes(ch)) return false
    const code = ch.codePointAt(0) ?? 0
    return code >= 0x20 && code !== 0x7f
  }).join("").trim()
  const buf = Buffer.from(cleaned)
  if (buf.length <= 200) return cleaned
  let cut = 200
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--
  return buf.subarray(0, cut).toString("utf8").trim()
}

export function wrapEnvelope(from: string, name: string, body: string): string {
  if (!addressSafe(from)) throw new Error("envelope from address is not a well-formed uds address")
  const safeName = sanitizeName(name)
  if (!safeName) throw new Error("sender name is empty after sanitizing")
  const escaped = body.replaceAll(`</${TAG}`, `<\\/${TAG}`)
  return `<${TAG} from=${goQuote(from)} from-name=${goQuote(safeName)}>\n${escaped}\n</${TAG}>`
}

export function unwrapEnvelope(text: string): { text: string; fromName?: string; from?: string } {
  const match = text.match(/^<cross-session-message\b([^>]*)>\n([\s\S]*)\n<\/cross-session-message>$/)
  if (!match) return { text }
  const attrs = match[1]
  const from = /(?:^|\s)from="([^"]*)"/.exec(attrs)?.[1]
  const fromName = /(?:^|\s)from-name="([^"]*)"/.exec(attrs)?.[1]
  return {
    text: match[2].replaceAll(`<\\/${TAG}`, `</${TAG}`),
    from,
    fromName,
  }
}

export function splitRoute(text: string): { to?: string; body: string } {
  const match = text.match(/^to:\s*([^\n]+)\n([\s\S]*)$/i)
  if (!match) return { body: text }
  const to = match[1].trim()
  const body = match[2].replace(/^\n/, "")
  if (!to || !body.trim()) return { body: text }
  return { to, body }
}

export function encodeUserFrame(input: UserFrameInput): { msgId: string; line: string } {
  const text = input.text.trim()
  if (!text) throw new Error("message text is empty")
  if (text.length > MAX_TEXT_CHARS) throw new Error(`message is ${text.length} characters; the limit is ${MAX_TEXT_CHARS}`)
  const msgId = input.msgId || newId()
  const content = input.wrap === false || !input.from || !input.fromName
    ? text
    : wrapEnvelope(input.from, input.fromName, text)
  const frame: Record<string, unknown> = {
    msgV: PROTOCOL_VERSION,
    msg_id: msgId,
    type: "user",
    message: { role: "user", content },
    priority: input.priority ?? "next",
  }
  if (input.from) frame.from = input.from
  if (input.sessionId) frame.session_id = input.sessionId
  const line = JSON.stringify(frame)
  if (Buffer.byteLength(line) >= MAX_FRAME_BYTES) throw new Error("frame exceeds the 1 MiB line cap")
  return { msgId, line }
}

export function encodeReceipt(input: { msgId: string; origMsgId: string; status: string; from: string; reason?: string }): string {
  return JSON.stringify({
    msgV: PROTOCOL_VERSION,
    msg_id: input.msgId,
    type: "control",
    action: "peer_message_status",
    status: input.status,
    orig_msg_id: input.origMsgId,
    from: input.from,
    ...(input.reason ? { reason: input.reason } : {}),
  })
}

export function keySuffix(socketPath: string): string {
  if (!inSocketNamespace(socketPath)) throw new Error("refusing to hash a socket outside the inbox namespace")
  return `.${createHash("sha256").update(socketPath).digest("hex")}.key`
}

export async function processStartToken(pid: number): Promise<string> {
  const { stdout } = await run("ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    timeout: 1000,
  })
  const token = stdout.trim()
  if (!token) throw new Error(`ps reported no start time for pid ${pid}`)
  return token
}

export function partyKey(kind: "opencode" | "claude", id: string): string {
  return `${kind}:${id}`
}

export function threadId(left: string, right: string): string {
  const [a, b] = [left, right].sort()
  return createHash("sha256").update(`${a}|${b}`).digest("hex").slice(0, 20)
}

export function mailName(title: string, sessionID: string): string {
  const base = sanitizeName(title).replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40)
  const suffix = sessionID.replace(/[^A-Za-z0-9]/g, "").slice(-4).toLowerCase() || "sess"
  return base ? `${base}-${suffix}` : `session-${suffix}`
}
