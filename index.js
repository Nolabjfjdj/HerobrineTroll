const mineflayer = require('mineflayer')
const express = require('express')

const app = express()
const PORT = Number(process.env.PORT || 10000)
const MC_HOST = process.env.MC_HOST
const MC_PORT = Number(process.env.MC_PORT || 25565)
const MC_VERSION = process.env.MC_VERSION || '1.21.4'
const IDLE_SECONDS = Math.max(8, Number(process.env.IDLE_SECONDS || 12))
const MAX_DISTANCE = Math.max(8, Number(process.env.MAX_DISTANCE || 18))
const APPEAR_DISTANCE = Math.max(2, Number(process.env.APPEAR_DISTANCE || 3))
const APPEAR_SECONDS = Math.max(1, Number(process.env.APPEAR_SECONDS || 5))
const TROLL_ENABLED = process.env.TROLL_ENABLED !== 'false'

let bot = null
let connected = false
let lastError = null
let reconnectTimer = null
let reconnectDelay = 5000
let stopping = false
let lastConnectedAt = null
let trollTimer = null
let returnTimer = null
let currentAction = 'waiting'
let playerActivity = new Map()
let playerCooldowns = new Map()
let currentTarget = null
let previousPosition = null
let apparitionPosition = null
let targetStartPosition = null
let returning = false

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

function sendTeleport(position) {
  if (!bot || !position) return

  const x = Number(position.x.toFixed(2))
  const y = Number(position.y.toFixed(2))
  const z = Number(position.z.toFixed(2))
  bot.chat(`/tp ${bot.username} ${x} ${y} ${z}`)
}

function clearTrollTimers() {
  if (trollTimer) clearTimeout(trollTimer)
  if (returnTimer) clearTimeout(returnTimer)
  trollTimer = null
  returnTimer = null
}

function resetTrollState() {
  clearTrollTimers()
  currentAction = 'waiting'
  currentTarget = null
  previousPosition = null
  apparitionPosition = null
  targetStartPosition = null
  returning = false
}

function returnToPreviousPosition(reason) {
  if (!connected || !bot || !previousPosition || returning) return

  returning = true
  clearTrollTimers()
  currentAction = 'returning'
  console.log(`Herobrine is returning to its previous position: ${reason}`)

  try {
    sendTeleport(previousPosition)
  } catch (error) {
    lastError = error.message
    console.error('Could not teleport Herobrine back:', error.message)
  }

  const target = currentTarget
  if (target) playerCooldowns.set(target, Date.now() + 45000)

  setTimeout(() => {
    if (!connected) return
    currentAction = 'waiting'
    currentTarget = null
    previousPosition = null
    apparitionPosition = null
    targetStartPosition = null
    returning = false
    scheduleTroll(3500 + Math.floor(Math.random() * 5000))
  }, 900)
}

function samplePlayerActivity() {
  if (!bot?.entity) return

  const now = Date.now()

  for (const [username, player] of Object.entries(bot.players)) {
    const entity = player.entity
    if (!entity || username === bot.username || entity.type !== 'player') continue

    const position = entity.position
    const previous = playerActivity.get(username)

    if (!previous || previous.position.distanceTo(position) > 0.35) {
      playerActivity.set(username, { position: position.clone(), lastMovedAt: now })
    } else {
      previous.position = position.clone()
    }
  }

  for (const username of playerActivity.keys()) {
    if (!bot.players[username]?.entity) playerActivity.delete(username)
  }

  if (currentAction === 'appearing' && currentTarget && apparitionPosition && targetStartPosition) {
    const target = bot.players[currentTarget]?.entity
    if (!target) {
      returnToPreviousPosition('target left the server')
      return
    }

    const startDistance = targetStartPosition.distanceTo(apparitionPosition)
    const currentDistance = target.position.distanceTo(apparitionPosition)
    const movedTowardHerobrine = startDistance - currentDistance >= 0.8

    if (movedTowardHerobrine) {
      returnToPreviousPosition('the player approached')
    }
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

    const distance = bot.entity.position.distanceTo(entity.position)
    if (distance < 5 || distance > MAX_DISTANCE || distance >= bestDistance) continue

    best = { username, entity, distance }
    bestDistance = distance
  }

  return best
}

function scheduleTroll(delay = 2500) {
  if (!connected || !TROLL_ENABLED || stopping || currentAction !== 'waiting') return
  if (trollTimer) clearTimeout(trollTimer)

  trollTimer = setTimeout(() => {
    trollTimer = null
    runTrollStep()
  }, delay)
}

function teleportNearPlayer(target) {
  if (!bot?.entity || !target?.entity) return

  previousPosition = bot.entity.position.clone()
  targetStartPosition = target.entity.position.clone()

  const yaw = target.entity.yaw
  const behindX = -Math.sin(yaw)
  const behindZ = Math.cos(yaw)
  apparitionPosition = target.entity.position.offset(
    -behindX * APPEAR_DISTANCE,
    0,
    -behindZ * APPEAR_DISTANCE
  )

  currentTarget = target.username
  currentAction = 'appearing'

  try {
    sendTeleport(apparitionPosition)
    console.log(`Herobrine appeared near ${target.username}.`)
  } catch (error) {
    lastError = error.message
    console.error('Could not teleport Herobrine to the player:', error.message)
    resetTrollState()
    scheduleTroll(5000)
    return
  }

  returnTimer = setTimeout(() => {
    returnToPreviousPosition('five-second appearance ended')
  }, APPEAR_SECONDS * 1000)
}

function runTrollStep() {
  if (!connected || !bot?.entity || !TROLL_ENABLED || stopping || currentAction !== 'waiting') return

  const target = findIdleTarget()

  if (!target) {
    scheduleTroll(2500 + Math.floor(Math.random() * 3500))
    return
  }

  teleportNearPlayer(target)
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
    resetTrollState()
    console.log('Herobrine has entered the world.')

    if (TROLL_ENABLED) {
      console.log('Herobrine teleport troll behavior is enabled.')
      trollTimer = setTimeout(() => {
        trollTimer = null
        samplePlayerActivity()
        scheduleTroll(1500)
      }, 2000)
    }
  })

  bot.on('physicsTick', samplePlayerActivity)

  bot.on('kicked', reason => {
    connected = false
    lastError = typeof reason === 'string' ? reason : JSON.stringify(reason)
    console.log('Herobrine was kicked:', lastError)
    resetTrollState()
  })

  bot.on('error', error => {
    lastError = error.message
    console.error('Minecraft connection error:', error.message)
  })

  bot.once('end', reason => {
    connected = false
    resetTrollState()
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
  resetTrollState()

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
