import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { threadId as makeThreadId } from "./protocol.ts"

export const ROOT = path.join(homedir(), ".local", "share", "opencode", "agent-mail")
const RECORDS = path.join(ROOT, "records")
const THREADS = path.join(ROOT, "threads")
const MAX_THREAD = 2000
const MAX_EVENTS = 10_000

export type MessageStatus =
  | "recorded"
  | "admitted"
  | "accepted"
  | "held"
  | "delivered"
  | "denied"
  | "expired"
  | "refused"
  | "uncertain"
  | "failed"
  | "dropped"

export interface Party {
  kind: "opencode" | "claude"
  id: string
  name: string
  address?: string
}

export interface MailRecord {
  id: string
  at: string
  threadId: string
  from: Party
  to: Party
  text: string
  transport: "opencode" | "claude"
  direction: "in" | "out"
  status: MessageStatus
  statusAt: string
  reason?: string
  sessionID?: string
  deliveredToAgent?: boolean
  deliveringUntil?: string
}

export interface ThreadIndex {
  id: string
  parties: [string, string]
  names: Record<string, string>
  messageIds: string[]
  updatedAt: string
  preview: string
}

export interface Presence {
  sessionID: string
  name: string
  title: string
  directory: string
  agent: string
  updatedAt: string
  // The name the session had before it was given a human name; still accepted when routing.
  formerName?: string
}

// One hundred simple human names. Each OpenCode session gets one of its own, so the coordinator can
// address it and recognise its pull requests ("Agent: <Name>").
export const HUMAN_NAMES = [
  "Ana", "Bruno", "Carla", "Daniel", "Elisa", "Felipe", "Gabriela", "Hugo", "Isabel", "Joao",
  "Karina", "Lucas", "Marina", "Nicolas", "Olivia", "Paulo", "Rafaela", "Samuel", "Tatiana", "Vitor",
  "Alice", "Bernardo", "Camila", "Diego", "Eduarda", "Fabio", "Giovana", "Henrique", "Ingrid", "Julia",
  "Leonardo", "Mariana", "Nathalia", "Otavio", "Patricia", "Renato", "Sofia", "Thiago", "Valentina", "Wagner",
  "Adriana", "Beatriz", "Caio", "Debora", "Emanuel", "Fernanda", "Gustavo", "Helena", "Igor", "Jessica",
  "Laura", "Marcelo", "Natalia", "Pedro", "Raquel", "Sergio", "Talita", "Vinicius", "Yasmin", "Andre",
  "Bianca", "Cesar", "Denise", "Erick", "Flavia", "Gilberto", "Heloisa", "Ivan", "Juliana", "Larissa",
  "Mateus", "Noemi", "Priscila", "Rodrigo", "Sabrina", "Tomas", "Vanessa", "Arthur", "Barbara", "Cristina",
  "Davi", "Elena", "Francisco", "Gisele", "Hector", "Irene", "Jorge", "Leticia", "Miguel", "Nina",
  "Pietra", "Ricardo", "Silvia", "Teresa", "Ulisses", "Vera", "Wesley", "Zeca", "Clara", "Manuel",
] as const

// claimHumanName returns the human name held by sessionID, assigning the first free one on first use.
// The assignment is kept in names.json and is never pruned, so a session keeps its name for good. When
// all hundred are held, a name whose session is no longer present is reused; failing that, a numbered one.
export async function claimHumanName(sessionID: string): Promise<string> {
  return withLock("names", async () => {
    const file = path.join(ROOT, "names.json")
    const held = (await readJson<Record<string, string>>(file)) ?? {}
    if (held[sessionID]) return held[sessionID]
    const taken = new Set(Object.values(held))
    let name: string | undefined = HUMAN_NAMES.find((item) => !taken.has(item))
    if (!name) {
      const live = new Set((await listPresence()).map((item) => item.sessionID))
      const reusable = Object.entries(held).find(([id]) => !live.has(id))
      if (reusable) {
        name = reusable[1]
        delete held[reusable[0]]
      }
    }
    if (!name) name = `Agent${Object.keys(held).length + 1}`
    held[sessionID] = name
    await writeJson(file, held)
    return name
  })
}

async function ensure(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await stat(dir)
  if (!info.isDirectory()) throw new Error(`${dir} is not a directory`)
}

export async function ready() {
  await ensure(ROOT)
  await ensure(RECORDS)
  await ensure(THREADS)
}

async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  await ready()
  const lock = path.join(ROOT, `${name}.lock`)
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      await handle.close()
      try {
        return await fn()
      } finally {
        await unlink(lock).catch(() => {})
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      // A holder releases the lock within milliseconds; one older than 10 s was left by a process that died
      // holding it (a service restart), and would otherwise block every delivery until removed by hand.
      const held = await stat(lock).catch(() => undefined)
      if (held && Date.now() - held.mtimeMs > 10_000) await unlink(lock).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`agent-mail lock timed out: ${name}`)
}

async function writeJson(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 2_000_000) return undefined
      return JSON.parse(await handle.readFile({ encoding: "utf8" })) as T
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export async function appendEvent(event: Record<string, unknown>) {
  await withLock("events", async () => {
    const file = path.join(ROOT, "events.jsonl")
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`
    const handle = await open(file, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      await handle.appendFile(line)
    } finally {
      await handle.close()
    }
    const info = await stat(file)
    if (info.size < 8_000_000) return
    const raw = await readFile(file, "utf8")
    const lines = raw.trim().split("\n").filter(Boolean)
    const kept = lines.slice(-MAX_EVENTS)
    await writeFile(file, `${kept.join("\n")}\n`, { mode: 0o600 })
  })
}

export async function saveRecord(record: MailRecord) {
  await ready()
  await writeJson(path.join(RECORDS, `${record.id}.json`), record)
  await withLock("threads", async () => {
    const file = path.join(THREADS, `${record.threadId}.json`)
    const current = await readJson<ThreadIndex>(file)
    const names = { ...(current?.names ?? {}), [partyOf(record.from)]: record.from.name, [partyOf(record.to)]: record.to.name }
    const messageIds = [...(current?.messageIds ?? []).filter((id) => id !== record.id), record.id]
    const dropped = messageIds.splice(0, Math.max(0, messageIds.length - MAX_THREAD))
    const next: ThreadIndex = {
      id: record.threadId,
      parties: partiesOf(record.from, record.to),
      names,
      messageIds,
      updatedAt: record.at,
      preview: record.text.replace(/\s+/g, " ").slice(0, 160),
    }
    await writeJson(file, next)
    await Promise.all(dropped.map((id) => rm(path.join(RECORDS, `${id}.json`), { force: true })))
  })
}

export async function updateRecord(id: string, status: MessageStatus, reason?: string) {
  const file = path.join(RECORDS, `${id}.json`)
  const current = await readJson<MailRecord>(file)
  if (!current) return undefined
  const next: MailRecord = { ...current, status, statusAt: new Date().toISOString(), ...(reason ? { reason } : {}) }
  await writeJson(file, next)
  await appendEvent({ type: "status", id, status, reason })
  return next
}

export async function getRecord(id: string) {
  return readJson<MailRecord>(path.join(RECORDS, `${id}.json`))
}

export async function claimPending(sessionID: string): Promise<MailRecord[]> {
  return withLock("delivery", async () => {
    const names = await readdir(RECORDS).catch(() => [])
    const now = Date.now()
    const claimed: MailRecord[] = []
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const record = await readJson<MailRecord>(path.join(RECORDS, name))
      if (!record || record.deliveredToAgent !== false) continue
      if (record.to.kind !== "opencode" || record.to.id !== sessionID || record.from.id === sessionID) continue
      if (record.deliveringUntil && Date.parse(record.deliveringUntil) > now) continue
      const next = { ...record, deliveringUntil: new Date(now + 30_000).toISOString() }
      await writeJson(path.join(RECORDS, name), next)
      claimed.push(next)
    }
    return claimed
  })
}

export async function markDelivered(id: string) {
  const current = await getRecord(id)
  if (!current) return
  await writeJson(path.join(RECORDS, `${id}.json`), { ...current, deliveredToAgent: true, deliveringUntil: undefined })
}

export async function releaseClaim(id: string) {
  const current = await getRecord(id)
  if (!current || current.deliveredToAgent) return
  await writeJson(path.join(RECORDS, `${id}.json`), { ...current, deliveringUntil: undefined })
}

export function partyOf(party: Party): string {
  return `${party.kind}:${party.id}`
}

function partiesOf(from: Party, to: Party): [string, string] {
  return [partyOf(from), partyOf(to)].sort() as [string, string]
}

export function conversationId(from: Party, to: Party): string {
  return makeThreadId(partyOf(from), partyOf(to))
}

export async function threadsFor(party: string): Promise<ThreadIndex[]> {
  await ready()
  const names = await readdir(THREADS).catch(() => [])
  const found: ThreadIndex[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const thread = await readJson<ThreadIndex>(path.join(THREADS, name))
    if (thread?.parties.includes(party)) found.push(thread)
  }
  return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function readConversation(id: string, limit: number): Promise<{ thread?: ThreadIndex; messages: MailRecord[] }> {
  const thread = await readJson<ThreadIndex>(path.join(THREADS, `${id}.json`))
  if (!thread) return { messages: [] }
  const ids = thread.messageIds.slice(-limit)
  const messages = (await Promise.all(ids.map((item) => getRecord(item)))).filter((item): item is MailRecord => Boolean(item))
  return { thread, messages }
}

export async function touchPresence(entry: Presence) {
  await withLock("presence", async () => {
    const file = path.join(ROOT, "presence.json")
    const current = (await readJson<Record<string, Presence>>(file)) ?? {}
    current[entry.sessionID] = entry
    const cutoff = Date.now() - 12 * 60 * 60 * 1000
    for (const [id, item] of Object.entries(current)) {
      if (Date.parse(item.updatedAt) < cutoff) delete current[id]
    }
    await writeJson(file, current)
  })
}

export async function listPresence(): Promise<Presence[]> {
  const current = (await readJson<Record<string, Presence>>(path.join(ROOT, "presence.json"))) ?? {}
  return Object.values(current).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function rememberRoute(address: string, sessionID: string) {
  await withLock("routes", async () => {
    const file = path.join(ROOT, "routes.json")
    const current = (await readJson<Record<string, { sessionID: string; at: string }>>(file)) ?? {}
    current[address] = { sessionID, at: new Date().toISOString() }
    await writeJson(file, current)
  })
}

export async function routeFor(address: string): Promise<string | undefined> {
  const current = (await readJson<Record<string, { sessionID: string; at: string }>>(path.join(ROOT, "routes.json"))) ?? {}
  return current[address]?.sessionID
}

export async function readState<T>(name: string): Promise<T | undefined> {
  await ready()
  return readJson<T>(path.join(ROOT, name))
}

export async function writeState(name: string, value: unknown) {
  await ready()
  await writeJson(path.join(ROOT, name), value)
}
