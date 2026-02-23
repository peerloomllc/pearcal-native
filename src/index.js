import Pear from 'pear'

// ─── Message helpers ──────────────────────────────────────────────────────────
function send (msg) {
  Pear.message(msg)
}

function sendResponse (id, result) {
  send({ type: 'response', id, result })
}

function sendError (id, error) {
  send({ type: 'response', id, error })
}

function sendEvent (event, data) {
  send({ type: 'event', event, data })
}

// ─── Listen for calls from UI ─────────────────────────────────────────────────
Pear.messages({ type: undefined }, async msg => {
  if (!msg.method) return
  try {
    const result = await dispatch(msg.method, msg.args ?? [])
    sendResponse(msg.id, result)
  } catch (e) {
    sendError(msg.id, e.message)
  }
})

// ─── Method dispatcher ────────────────────────────────────────────────────────
async function dispatch (method, args) {
  switch (method) {
    case 'ping': return 'pong'
    default: throw new Error(`Unknown method: ${method}`)
  }
}

// ─── Teardown ─────────────────────────────────────────────────────────────────
Pear.teardown?.(() => process.exit(0))

// ─── Signal ready ─────────────────────────────────────────────────────────────
sendEvent('ready')
console.log('PearCal backend started')
