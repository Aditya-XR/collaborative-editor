// Edit fan-out under load, through nginx to every API instance (ADR 0004). Run with
// infra/k6/run.sh, which also counts Redis PUBLISH commands and samples memory.
//
// DOCS documents, PER_DOC editors each. Every editor types a few characters every EDIT_MS, and
// measures how long everyone else's characters take to reach it. nginx spreads the sockets over
// the instances, so most edits cross from one instance to another through Redis.
//
// k6 has no Yjs, so the edits are Yjs updates encoded by hand: each editor appends to its own run
// of text in a root type named "load", which the editor UI never shows. The text it types is its
// send time ("t1760160000123."); receivers find those in the raw update bytes, since Yjs stores
// string content as plain UTF-8.

import http from 'k6/http'
import ws from 'k6/ws'
import { check, fail } from 'k6'
import { Counter, Trend } from 'k6/metrics'

const BASE = __ENV.BASE_URL || 'http://nginx:8080'
const WS_BASE = BASE.replace(/^http/, 'ws')
const DOCS = Number(__ENV.DOCS || 20)
const PER_DOC = Number(__ENV.PER_DOC || 5)
const EDIT_MS = Number(__ENV.EDIT_MS || 500)
const DURATION_S = Number(__ENV.DURATION || 60)
const JSON_HEADERS = { 'Content-Type': 'application/json' }

export const options = {
  setupTimeout: '120s',
  scenarios: {
    editors: {
      executor: 'per-vu-iterations',
      vus: DOCS * PER_DOC,
      iterations: 1,
      maxDuration: `${DURATION_S + 60}s`,
    },
  },
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    fanout_latency: ['p(95)<250'],
    edits_received: ['count>0'],
  },
}

const latency = new Trend('fanout_latency', true)
const editsSent = new Counter('edits_sent')
const editsReceived = new Counter('edits_received')

export function setup() {
  const email = `load-${Date.now()}@example.com`
  const registered = http.post(
    `${BASE}/api/auth/register`,
    JSON.stringify({ email, name: 'Load test', password: 'correct horse battery staple' }),
    { headers: JSON_HEADERS },
  )
  if (registered.status !== 201) fail(`register: ${registered.status} ${registered.body}`)
  const token = registered.json('access_token')
  const auth = { headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` } }
  const docs = []
  for (let i = 0; i < DOCS; i++) {
    const created = http.post(`${BASE}/api/documents`, JSON.stringify({ title: `Load ${i}` }), auth)
    if (created.status !== 201) fail(`create document: ${created.status}`)
    docs.push(created.json('id'))
  }
  return { token, docs }
}

export default function (data) {
  const doc = data.docs[(__VU - 1) % DOCS]
  const auth = { headers: { ...JSON_HEADERS, Authorization: `Bearer ${data.token}` } }
  const granted = http.post(`${BASE}/api/collab/tickets`, JSON.stringify({ document_id: doc }), auth)
  if (!check(granted, { 'ticket issued': (r) => r.status === 201 })) return
  const url = `${WS_BASE}/api/ws/docs/${doc}?ticket=${encodeURIComponent(granted.json('ticket'))}`

  const client = 1 + Math.floor(Math.random() * 0x7ffffffe)
  let clock = 0 // how many characters this editor has typed: the next item's clock

  const response = ws.connect(url, null, (socket) => {
    socket.on('open', () => {
      // Start at a random moment, so the editors do not all type in step.
      socket.setTimeout(() => {
        socket.setInterval(() => {
          const typed = `t${Date.now()}.`
          socket.sendBinary(syncUpdate(insertText(client, clock, typed)))
          clock += typed.length
          editsSent.add(1)
        }, EDIT_MS)
      }, Math.random() * EDIT_MS)
      socket.setTimeout(() => socket.close(), DURATION_S * 1000)
    })
    socket.on('binaryMessage', (message) => {
      const now = Date.now()
      const bytes = new Uint8Array(message)
      if (bytes[0] !== 0 || bytes[1] !== 2) return // only sync updates carry edits
      const text = latin1(bytes)
      const marker = /t(\d{13})\./g
      let found
      while ((found = marker.exec(text)) !== null) {
        latency.add(now - Number(found[1]))
        editsReceived.add(1)
      }
    })
    socket.on('error', (e) => console.error(`socket error: ${e.error()}`))
  })
  check(response, { 'websocket opened': (r) => r && r.status === 101 })
}

// ----- Yjs, by hand -----------------------------------------------------------------------------

/** A Yjs v1 update inserting `text` after this client's previous character (or at the start). */
function insertText(client, clock, text) {
  const out = []
  varUint(out, 1) // one client's structs
  varUint(out, 1) // one struct
  varUint(out, client)
  varUint(out, clock)
  const STRING_CONTENT = 4
  if (clock === 0) {
    out.push(STRING_CONTENT) // no origins: the parent is named instead
    varUint(out, 1) // the parent is a root type, given by name
    varString(out, 'load')
  } else {
    out.push(0x80 | STRING_CONTENT) // left origin: this client's last character
    varUint(out, client)
    varUint(out, clock - 1)
  }
  varString(out, text)
  varUint(out, 0) // empty delete set
  return out
}

/** The sync protocol's "update" message: [SYNC, UPDATE, length, update]. */
function syncUpdate(update) {
  const out = [0, 2]
  varUint(out, update.length)
  return new Uint8Array(out.concat(update)).buffer
}

function varUint(out, value) {
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80)
    value = Math.floor(value / 128)
  }
  out.push(value)
}

function varString(out, ascii) {
  varUint(out, ascii.length)
  for (let i = 0; i < ascii.length; i++) out.push(ascii.charCodeAt(i))
}

function latin1(bytes) {
  let text = ''
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i])
  return text
}
