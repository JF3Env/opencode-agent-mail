import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { homedir } from "node:os"
import net from "node:net"
import path from "node:path"
import { promisify } from "node:util"
import {
  BRIDGE_NAME,
  MAX_FRAME_BYTES,
  SOCKET_DIR,
  addressSafe,
  encodeReceipt,
  encodeUserFrame,
  inSocketNamespace,
  keySuffix,
  newId,
  parseAddress,
  peerToken,
  processStartToken,
  socketPathForPid,
  splitRoute,
  toAddress,
  unwrapEnvelope,
} from "./protocol.ts"
import { appendEvent, getRecord, readState, updateRecord, writeState } from "./store.ts"

const run = promisify(execFile)
const SESSIONS = path.join(homedir(), ".claude", "sessions")

export interface ClaudePeer {
  pid: number
  sessionId: string
  name: string
  cwd: string
  status: string
  socketPath: string
  reachable: boolean
}

export interface InboundMessage {
  msgId: string
  text: string
  fromName?: string
  fromAddress?: string
  to?: string
  sessionId?: string
}

export interface Bridge {
  pid: number
  socketPath: string
  address: string
  sessionId: string
  owner: boolean
  close: () => Promise<void>
}

async function directoryIsPrivate(dir: string) {
  const info = await lstat(dir)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${dir} is not a private directory`)
  if ((info.mode & 0o077) !== 0) throw new Error(`${dir} is group or world accessible`)
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${dir} is not owned by this user`)
}

async function probe(socketPath: string, timeoutMs = 250): Promise<boolean> {
  if (!inSocketNamespace(socketPath)) return false
  return new Promise((resolve) => {
    const socket = net.connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    socket.once("connect", () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

async function writePrivate(file: string, body: string) {
  const tmp = `${file}.${process.pid}.tmp`
  const handle = await open(tmp, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(body)
  } finally {
    await handle.close()
  }
  await chmod(tmp, 0o600)
  const { rename } = await import("node:fs/promises")
  await rename(tmp, file)
}

async function readNoFollow(file: string, max: number): Promise<string | undefined> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > max) return undefined
      return await handle.readFile({ encoding: "utf8" })
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    return undefined
  }
}

export async function listClaudePeers(): Promise<ClaudePeer[]> {
  let names: string[] = []
  try {
    names = await readdir(SESSIONS)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const peers: ClaudePeer[] = []
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    if (pid === process.pid) continue
    const raw = await readNoFollow(path.join(SESSIONS, name), 256 * 1024)
    if (!raw) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      continue
    }
    const socketPath = typeof parsed.messagingSocketPath === "string" ? parsed.messagingSocketPath : ""
    if (!socketPath || !inSocketNamespace(socketPath)) continue
    peers.push({
      pid,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
      name: typeof parsed.name === "string" ? parsed.name : `pid-${pid}`,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      status: typeof parsed.status === "string" ? parsed.status : "",
      socketPath,
      reachable: await probe(socketPath),
    })
  }
  return peers.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid)
}

async function lookupToken(socketPath: string): Promise<string> {
  const suffix = keySuffix(socketPath)
  let names: string[] = []
  try {
    names = await readdir(SESSIONS)
  } catch {
    return ""
  }
  let best = ""
  let rank = -1
  for (const name of names) {
    if (!name.endsWith(suffix)) continue
    const match = /^(\d+)\.[0-9a-f]{64}\.key$/.exec(name)
    if (!match) continue
    const owner = Number(match[1])
    const raw = await readNoFollow(path.join(SESSIONS, name), 4096)
    if (!raw) continue
    let parsed: { peerToken?: string; procStart?: string }
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (!parsed.peerToken || !/^[0-9a-f]{32}$/.test(parsed.peerToken)) continue
    let score = 0
    try {
      process.kill(owner, 0)
      score = 1
      if (parsed.procStart && parsed.procStart === await processStartToken(owner)) score = 2
    } catch {
      score = 0
    }
    if (score > rank) {
      best = parsed.peerToken
      rank = score
    }
  }
  return best
}

export async function sendFrame(socketPath: string, lines: string[], signal?: AbortSignal): Promise<"accepted" | "uncertain"> {
  if (!inSocketNamespace(socketPath)) throw new Error("refusing to connect outside the inbox namespace")
  const payload = Buffer.from(`${lines.join("\n")}\n`)
  if (payload.length >= MAX_FRAME_BYTES) throw new Error("frame exceeds the 1 MiB line cap")
  const socket = net.connect(socketPath)
  const fail = (error: Error) => {
    socket.destroy()
    throw error
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out connecting to ${socketPath}`)), 5000)
    const onAbort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"))
    signal?.addEventListener("abort", onAbort, { once: true })
    socket.once("connect", () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve()
    })
    socket.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  }).catch((error) => fail(error instanceof Error ? error : new Error(String(error))))
  socket.write(payload)
  await new Promise((resolve) => setTimeout(resolve, 150))
  socket.end()
  const closed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 2000)
    socket.once("close", () => {
      clearTimeout(timer)
      resolve(true)
    })
    socket.once("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
  return closed ? "accepted" : "uncertain"
}

export async function sendToClaude(peer: ClaudePeer, text: string, fromName: string, fromAddress: string, signal?: AbortSignal, msgId?: string) {
  if (!peer.reachable) throw new Error(`${peer.name} has no reachable inbox`)
  if (!peer.sessionId) throw new Error(`${peer.name} has no session id; refusing to send to a socket that might have been reused`)
  const token = await lookupToken(peer.socketPath)
  const frame = encodeUserFrame({
    msgId,
    text,
    from: fromAddress,
    fromName,
    sessionId: peer.sessionId,
  })
  const lines = token ? [JSON.stringify({ type: "auth", token }), frame.line] : [frame.line]
  const outcome = await sendFrame(peer.socketPath, lines, signal)
  return { msgId: frame.msgId, outcome }
}

async function publishRegistry(input: { pid: number; socketPath: string; sessionId: string; token: string }) {
  await mkdir(SESSIONS, { recursive: true, mode: 0o700 })
  await directoryIsPrivate(SESSIONS)
  const procStart = await processStartToken(input.pid).catch(() => "")
  const now = Date.now()
  const registry = {
    pid: input.pid,
    pidDomain: process.platform,
    sessionId: input.sessionId,
    name: BRIDGE_NAME,
    nameSource: "explicit",
    cwd: process.cwd(),
    kind: "interactive",
    status: "idle",
    entrypoint: "cli",
    messagingSocketPath: input.socketPath,
    peerProtocol: 1,
    peerFeatures: ["reply_across_default_dirs"],
    procStart,
    startedAt: now,
    updatedAt: now,
    statusUpdatedAt: now,
    version: "opencode-agent-mail",
  }
  await writePrivate(path.join(SESSIONS, `${input.pid}.json`), `${JSON.stringify(registry, null, 2)}\n`)
  await writePrivate(path.join(SESSIONS, `${input.pid}${keySuffix(input.socketPath)}`), `${JSON.stringify({ peerToken: input.token, procStart })}\n`)
}

export async function bindBridge(onMessage: (message: InboundMessage) => Promise<boolean>): Promise<Bridge> {
  const pid = process.pid
  const socketPath = socketPathForPid(pid)
  const address = toAddress(socketPath)
  const saved = await readState<{ sessionId: string }>("bridge.json")
  const sessionId = saved?.sessionId || newId()
  await writeState("bridge.json", { sessionId })
  await mkdir(SOCKET_DIR, { recursive: true, mode: 0o700 })
  await directoryIsPrivate(SOCKET_DIR)
  if (await probe(socketPath)) {
    return { pid, socketPath, address, sessionId, owner: false, close: async () => {} }
  }
  await rm(socketPath, { force: true })
  const token = peerToken()
  const ownerToken = newId()
  const server = net.createServer((connection) => {
    connection.setTimeout(30_000)
    const lines = createInterface({ input: connection, crlfDelay: Infinity })
    lines.on("line", (line) => {
      if (Buffer.byteLength(line) >= MAX_FRAME_BYTES) {
        connection.destroy()
        return
      }
      void handleLine(line, address, onMessage).catch((error) => {
        console.error("agent-mail: inbound frame failed", error instanceof Error ? error.message : "unknown")
      })
    })
    connection.on("timeout", () => connection.destroy())
    connection.on("error", () => {})
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve())
  })
  await chmod(socketPath, 0o600)
  await publishRegistry({ pid, socketPath, sessionId, token })
  await writeState("listener.json", { pid, socketPath, address, sessionId, ownerToken, boundAt: new Date().toISOString() })
  return {
    pid,
    socketPath,
    address,
    sessionId,
    owner: true,
    close: async () => {
      const current = await readState<{ ownerToken?: string }>("listener.json")
      if (current?.ownerToken !== ownerToken) return
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(socketPath, { force: true })
      await rm(path.join(SESSIONS, `${pid}.json`), { force: true })
      await rm(path.join(SESSIONS, `${pid}${keySuffix(socketPath)}`), { force: true }).catch(() => {})
      await writeState("listener.json", { pid, bound: false, closedAt: new Date().toISOString() })
    },
  }
}

async function handleLine(line: string, selfAddress: string, onMessage: (message: InboundMessage) => Promise<boolean>) {
  if (!line.trim()) return
  let frame: Record<string, unknown>
  try {
    frame = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  if (frame.type === "auth") return
  if (frame.type === "control" && frame.action === "peer_message_status") {
    const orig = typeof frame.orig_msg_id === "string" ? frame.orig_msg_id : ""
    const status = typeof frame.status === "string" ? frame.status : ""
    const reason = typeof frame.reason === "string" ? frame.reason : undefined
    if (orig && ["held", "denied", "expired", "delivered", "refused"].includes(status)) {
      await updateRecord(orig, status as "held", reason)
    }
    return
  }
  if (frame.type === "control" && frame.action === "agent_mail_ping") {
    await writeState("ping.json", { at: new Date().toISOString() })
    return
  }
  if (frame.type !== "user") return
  const message = frame.message as { content?: unknown } | undefined
  if (!message || typeof message.content !== "string" || !message.content.trim()) return
  const fromAddress = typeof frame.from === "string" && addressSafe(frame.from) ? frame.from : undefined
  if (fromAddress === selfAddress) return
  const unwrapped = unwrapEnvelope(message.content)
  const routed = splitRoute(unwrapped.text)
  const msgId = typeof frame.msg_id === "string" ? frame.msg_id : newId()
  if (await getRecord(msgId)) return
  const delivered = await onMessage({
    msgId,
    text: routed.body,
    fromName: unwrapped.fromName,
    fromAddress,
    to: routed.to,
    sessionId: typeof frame.session_id === "string" ? frame.session_id : undefined,
  })
  if (fromAddress && delivered) {
    const receipt = encodeReceipt({
      msgId: newId(),
      origMsgId: msgId,
      status: "delivered",
      from: selfAddress,
      reason: "accepted by opencode agent-mail",
    })
    await sendFrame(parseAddress(fromAddress), [receipt]).catch(() => {})
  }
}

export async function claudeVersion(): Promise<string> {
  try {
    const { stdout } = await run("claude", ["--version"], { timeout: 2000 })
    return stdout.trim()
  } catch {
    return ""
  }
}
