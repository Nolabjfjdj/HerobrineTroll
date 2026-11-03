const mineflayer = require('mineflayer')
const express = require('express')

const app = express()
const PORT = Number(process.env.PORT || 10000)
const MC_HOST = process.env.MC_HOST
const MC_PORT = Number(process.env.MC_PORT || 25565)
const MC_VERSION = process.env.MC_VERSION || '1.21.4'
const IDLE_SECONDS = Math.max(8, Number(process.env.IDLE_SECONDS || 12))
const MAX_DISTANCE = Math.max(8, Number(process.env.MAX_DISTANCE || 18))
const TROLL_ENABLED = process.env.TROLL_ENABLED !== 'false'

let bot = null
let connected = false
let lastError = null
let reconnectTimer = null
let reconnectDelay = 5000
let stopping = false
let lastConnectedAt = null
let trollTimer = null
let currentAction = 'waiting'
let playerActivity = new Map()
let playerCooldowns = new Map()
let actionUntil = 0
let currentTarget = null

app.get('/', (req, res) => {
  res.type('html').send('<main><h1>Herobrine</h1><p>The entity is watching.</p><p><a href="/status">Bot status</a></p></main>')
})

app.get('/health', (req, res) => {
  res.status(200).json({
    http: 'online',
    service: 'Herobrine',
    minecraft: connected ? 'connected' : 'disconnected'
  })
})

app.get('/status', (req, res) => {
  res.json({
    name: 'Herobrine',
    minecraftVersion: MC_VERSION,
    connected,
    trollEnabled: TROLL_ENABLED,
    currentAction,
    target: currentTarget,
    username: bot?.username || 'Herobrine',
    position: bot?.entity?.position || null,
    lastConnectedAt,
    lastError
  })
})

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server listening on port ${PORT}`)
})

function scheduleReconnect() {
  if (stopping || reconnectTimer || !MC_HOST) return

  const delay = reconnectDelay
  console.log(`Next Minecraft connection attempt in ${Math.round(delay / 1000)} seconds.`)

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectMinecraft()
  }, delay)

  reconnectDelay = Math.min(reconnectDelay * 2, 60000)
}

function stopTrollLoop() {
  if (trollTimer) clearTimeout(trollTimer)
  trollTimer = null
  currentAction = 'waiting'
  currentTarget = null
  actionUntil = 0

  if (bot) {
    try {
      bot.clearControlStates()
    } catch {}
  }
}

function distanceBetween(a, b) {
  return a.distanceTo(b)
}

function samplePlayerActivity() {
  if (!bot?.entity) return

  const now = Date.now()

  for (const [username, player] of Object.entries(bot.players)) {
    const entity = player.entity
    if (!entity || username === bot.username || entity.type !== 'player') continue

    const position = entity.position
    const previous = playerActivity.get(username)

    if (!previous || distanceBetween(previous.position, position) > 0.35) {
      playerActivity.set(username, { position: position.clone(), lastMovedAt: now })
    } else {
      previous.position = position.clone()
    }
  }

  for (const username of playerActivity.keys()) {
    if (!bot.players[username]?.entity) playerActivity.delete(username)
  }
}

function findIdleTarget() {
  if (!bot?.entity) return null

  const now = Date.now()
  let best = null
  let bestDistance = Infinity

  for (const [username, player] of Object.entries(bot.players)) {
    const entity = player.entity
    const activity = playerActivity.get(username)

    if (!entity || !activity || username === bot.username || entity.type !== 'player') continue
    if ((now - activity.lastMovedAt) / 1000 < IDLE_SECONDS) continue
    if ((playerCooldowns.get(username) || 0) > now) continue

    const distance = distanceBetween(bot.entity.position, entity.position)
    if (distance < 5 || distance > MAX_DISTANCE || distance >= bestDistance) continue

    best = { username, entity, distance }
    bestDistance = distance
  }

  return best
}

function scheduleTroll(delay = 1800) {
  if (!connected || !TROLL_ENABLED || stopping) return
  if (trollTimer) clearTimeout(trollTimer)

  trollTimer = setTimeout(() => {
    trollTimer = null
    runTrollStep()
  }, delay)
}

async function lookAtPlayer(entity) {
  if (!bot || !entity?.position) return

  try {
    await bot.lookAt(entity.position.offset(0, 1.5, 0), true)
  } catch {}
}

async function runTrollStep() {
  if (!connected || !bot?.entity || !TROLL_ENABLED || stopping) return

  const now = Date.now()

  if (now < actionUntil) {
    scheduleTroll(Math.min(700, actionUntil - now))
    return
  }

  bot.clearControlStates()

  if (currentAction === 'approaching') {
    currentAction = 'watching'
    actionUntil = now + 4500
    scheduleTroll(4500)
    return
  }

  if (currentAction === 'watching' && currentTarget) {
    const target = bot.players[currentTarget]?.entity
    if (target) await lookAtPlayer(target)

    currentAction = 'retreating'
    actionUntil = now + 1100
    bot.setControlState('back', true)
    scheduleTroll(1100)
    return
  }

  if (currentAction === 'retreating') {
    bot.clearControlStates()
    if (currentTarget) playerCooldowns.set(currentTarget, now + 45000)
    currentAction = 'waiting'
    currentTarget = null
    actionUntil = 0
    scheduleTroll(3500 + Math.floor(Math.random() * 5000))
    return
  }

  const target = findIdleTarget()

  if (!target) {
    currentAction = 'waiting'
    scheduleTroll(2500 + Math.floor(Math.random() * 3500))
    return
  }

  currentTarget = target.username
  await lookAtPlayer(target.entity)

  if (target.distance > 8) {
    currentAction = 'approaching'
    actionUntil = now + 1200
    bot.setControlState('forward', true)
    scheduleTroll(1200)
  } else {
    currentAction = 'watching'
    actionUntil = now + 4500
    scheduleTroll(4500)
  }
}

function connectMinecraft() {
  if (stopping || !MC_HOST) return

  console.log(`Connecting to ${MC_HOST}:${MC_PORT} with Minecraft ${MC_VERSION}...`)

  try {
    bot = mineflayer.createBot({
      host: MC_HOST,
      port: MC_PORT,
      username: 'Herobrine',
      auth: 'offline',
      version: MC_VERSION
    })
  } catch (error) {
    lastError = error.message
    console.error('Could not create the Minecraft bot:', error.message)
    scheduleReconnect()
    return
  }

  bot.once('spawn', () => {
    connected = true
    lastError = null
    lastConnectedAt = new Date().toISOString()
    reconnectDelay = 5000
    playerActivity.clear()
    playerCooldowns.clear()
    currentAction = 'waiting'
    console.log('Herobrine has entered the world.')

    if (TROLL_ENABLED) {
      console.log('Herobrine troll behavior is enabled.')
      trollTimer = setTimeout(() => {
        trollTimer = null
        samplePlayerActivity()
        runTrollStep()
      }, 2000)
    }
  })

  bot.on('physicsTick', samplePlayerActivity)

  bot.on('kicked', reason => {
    connected = false
    lastError = typeof reason === 'string' ? reason : JSON.stringify(reason)
    console.log('Herobrine was kicked:', lastError)
    stopTrollLoop()
  })

  bot.on('error', error => {
    lastError = error.message
    console.error('Minecraft connection error:', error.message)
  })

  bot.once('end', reason => {
    connected = false
    stopTrollLoop()
    playerActivity.clear()
    console.log('Herobrine disconnected:', reason || 'connection ended')
    bot = null
    scheduleReconnect()
  })
}

if (!MC_HOST) {
  lastError = 'MC_HOST is not configured'
  console.error('Missing MC_HOST environment variable. HTTP status server is running.')
} else {
  connectMinecraft()
}

function shutdown(signal) {
  if (stopping) return
  stopping = true
  console.log(`Received ${signal}. Shutting down...`)

  if (reconnectTimer) clearTimeout(reconnectTimer)
  stopTrollLoop()

  if (bot) {
    try {
      bot.quit('Herobrine is restarting')
    } catch {}
  }

  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 10000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
