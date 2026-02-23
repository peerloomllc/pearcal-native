const send = (msg) => BareKit.IPC.write(Buffer.from(JSON.stringify(msg) + '\n'))

let db = null
let buf = ''

BareKit.IPC.on('data', chunk => {
  buf += chunk.toString()
  const lines = buf.split('\n')
  buf = lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.method === 'init') init(msg.dataDir)
      else if (msg.method === 'ping') send({ type: 'response', id: msg.id, result: 'pong' })
    } catch(e) {}
  }
})

async function init (dataDir) {
  try {
    const Hypercore = require('hypercore')
    const Hyperbee = require('hyperbee')
    console.log('Modules loaded')
    
    const core = new Hypercore(dataDir + '/core', { valueEncoding: 'json' })
    await core.ready()
    console.log('Hypercore ready')
    
    const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await bee.ready()
    console.log('Hyperbee ready')
    
    send({ type: 'event', event: 'ready' })
  } catch(e) {
    console.error('Init failed:', e.message)
    send({ type: 'event', event: 'error', data: e.message })
  }
}

send({ type: 'event', event: 'bareReady' })
