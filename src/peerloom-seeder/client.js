// The device side of the seeder protocol (protocol.js), for any app.
//
// The app decides which spaces go to which seeders and remembers what it
// paired with. This file only talks to seeders:
//
// - createPeering: a blind-peering instance that dials with the device's
//   swarm key, so the seeder recognises it as paired.
// - pair: meet a seeder from its link and ask it to trust this device.
// - createAsker: send requests (drop, keep, keyrings) to a paired seeder.
//
// blind-peering sends core keys and lengths. It never sends the encryption
// key or the topic key.

const BlindPeering = require('blind-peering')
const Wakeup = require('protomux-wakeup')
const Protomux = require('protomux')
const c = require('compact-encoding')
const b4a = require('b4a')
const { PAIR_WINDOW_MS, namesOf, pairTopic, parseSeederLink, cleanLabel } = require('./protocol')

const hex = (buf) => b4a.toString(buf, 'hex')

// blind-peering dials with `peering.keyPair`, which it never sets, so the DHT
// falls back to a random key per process. The seeder recognises paired
// devices by key, so dial with the device's swarm key (the one sent at
// pairing).
function createPeering ({ dht, store, keyPair, wakeup = new Wakeup(), ...opts }) {
  const peering = new BlindPeering(dht, store, { wakeup, ...opts })
  peering.keyPair = keyPair
  return peering
}

// Pair with a seeder from the link it shows. `app` is the label the seeder's
// dashboard shows for this device; leave it out to send none. Resolves
// { seederKey, style } once the seeder has accepted this device. Keep `style`
// with the seeder and pass it to the asker: it says which names it answers.
function pair ({ swarm, link, app = null, timeoutMs = PAIR_WINDOW_MS }) {
  const { rv, seederKey, style } = parseSeederLink(link)
  const names = namesOf(style)
  const topic = pairTopic(rv, style)
  const label = cleanLabel(app)
  return new Promise((resolve, reject) => {
    let done = false
    const channels = []
    const finish = (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(again)
      for (const ch of channels) { try { ch.close() } catch {} }
      swarm.off('connection', onConnection)
      swarm.leave(topic).catch(() => {})
      if (err) return reject(err)
      resolve({ seederKey: hex(seederKey), style })
    }
    const onConnection = (conn) => {
      // Talk only to the seeder the link names.
      if (!conn.remotePublicKey || !b4a.equals(conn.remotePublicKey, seederKey)) return
      const mux = Protomux.from(conn)
      const trust = { t: 'trust', deviceKey: hex(swarm.keyPair.publicKey) }
      if (label) trust.app = label
      const ch = mux.createChannel({ protocol: names.pairProtocol, id: rv, onopen: () => msg.send(trust) })
      if (!ch) return
      channels.push(ch)
      const msg = ch.addMessage({
        encoding: c.json,
        onmessage: (r) => {
          if (r && r.t === 'ok') finish(null)
          else if (r && r.t === 'no') finish(new Error(r.reason || 'The seeder refused'))
        }
      })
      ch.open()
    }
    const timer = setTimeout(() => finish(new Error('Could not reach the seeder. Check it is running and the pairing window is open.')), timeoutMs)
    swarm.on('connection', onConnection)
    for (const conn of swarm.connections) onConnection(conn)
    const discovery = swarm.join(topic, { server: false, client: true })
    // Look again while waiting, as joins do.
    const again = setInterval(() => discovery.refresh({ server: false, client: true }).catch(() => {}), 4000)
  })
}

// Requests to paired seeders.
//
// dht(): the DHT to dial with (a function, so an app can swap in a relaying
// one). keyPair: the device's swarm key pair, or a function returning it
// (for an app whose swarm starts later). openSocket(seederKey): an open
// connection to that seeder, if the app has one (the blind-peering backup
// connection); dialling a second one is slow, and the seeder then drops the
// backup connection in its favour. styleOf(seederKey): which names that
// seeder was paired under, default 'peerloom'.
//
// Requests to one seeder run one at a time, as the seeder answers on a single
// channel per connection. Resolves the seeder's { t: 'ok', ... } answer;
// rejects with err.answered = true when the seeder said no.
function createAsker ({ dht, keyPair, openSocket = () => null, styleOf = () => 'peerloom' }) {
  const queues = new Map() // seederKey -> the last request's promise

  function ask (seederKey, request, timeoutMs = 20000) {
    const prev = queues.get(seederKey) || Promise.resolve()
    // A new connection that fails without an answer is tried once more: if
    // the direct attempt could not holepunch, the second one may go through
    // a relay.
    const fresh = () => askOver(null, seederKey, request, timeoutMs).catch((e) => {
      if (e.answered) throw e
      return askOver(null, seederKey, request, timeoutMs)
    })
    const run = prev.catch(() => {}).then(() => {
      const open = usable(openSocket(seederKey))
      if (!open) return fresh()
      return askOver(open, seederKey, request, timeoutMs).catch((e) => {
        if (e.answered) throw e
        return fresh()
      })
    })
    queues.set(seederKey, run)
    run.catch(() => {}).then(() => { if (queues.get(seederKey) === run) queues.delete(seederKey) })
    return run
  }

  function usable (socket) {
    return socket && !socket.destroying && !socket.destroyed ? socket : null
  }

  // Over `socket` if given (left open afterwards), else over a new direct
  // connection that is closed once answered.
  function askOver (socket, seederKey, request, timeoutMs) {
    const own = !socket
    const protocol = namesOf(styleOf(seederKey)).seederProtocol
    return new Promise((resolve, reject) => {
      if (own) socket = dht().connect(b4a.from(seederKey, 'hex'), { keyPair: typeof keyPair === 'function' ? keyPair() : keyPair })
      let ch = null
      let finished = false
      const done = (err, value) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (ch) try { ch.close() } catch {}
        if (own) try { socket.destroy() } catch {}
        if (err) reject(err); else resolve(value)
      }
      const timer = setTimeout(() => done(new Error('seeder did not answer')), timeoutMs)
      const answer = (m) => {
        if (m && m.t === 'ok') return done(null, m)
        const err = new Error((m && m.reason) || 'refused')
        err.answered = true
        done(err)
      }
      const start = () => {
        ch = Protomux.from(socket).createChannel({
          protocol,
          onopen: () => msg.send(request),
          onclose: () => done(new Error('connection to the seeder closed'))
        })
        if (!ch) return done(new Error('could not open a channel'))
        const msg = ch.addMessage({ encoding: c.json, onmessage: answer })
        ch.open()
      }
      if (own) {
        socket.on('error', () => {})
        socket.on('open', start)
      } else {
        start()
      }
    })
  }

  return { ask }
}

module.exports = { createPeering, pair, createAsker }
