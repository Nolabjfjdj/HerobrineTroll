const mineflayer = require('mineflayer')
const express = require('express')
const { Vec3 } = require('vec3')

const app = express()
const PORT = Number(process.env.PORT || 10000)
const MC_HOST = process.env.MC_HOST
const MC_PORT = Number(process.env.MC_PORT || 25565)
const MC_VERSION = process.env.MC_VERSION || '1.21.4'
const IDLE_SECONDS = Math.max(8, Number(process.env.IDLE_SECONDS || 12))
const MIN_APPEAR_DISTANCE = Math.max(5, Number(process.env.MIN_APPEAR_DISTANCE || 6))
const MAX_APPEAR_DISTANCE = Math.max(MIN_APPEAR_DISTANCE + 1, Number(process.env.MAX_APPEAR_DISTANCE || 20))
const APPEAR_SECONDS = Math.max(1, Number(process.env.APPEAR_SECONDS || 5))
const LOOK_DOT_THRESHOLD = Math.min(0.99, Math.max(0.7, Number(process.env.LOOK_DOT_THRESHOLD || 0.93)))
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
let verifyTimer = null
let currentAction = 'waiting'
let playerActivity = new Map()
let playerCooldowns = new Map()
let currentTarget = null
let previousPosition = null
let apparitionPosition = null
let targetStartPosition = null
let returning = false

function log(message) {
  console.log('[Herobrine] ' + message)
}

app.get('/', (req, res) => {
  res.type('html').send('<main><h1>Herobrine</h1><p>The entity is watching.</p><p><a href="/status">Bot status</a></p></main>')
})

app.get('/health', (req, res) => {
  res.status(200).json({ http: 'online', service: 'Herobrine', minecraft: connected ? 'connected' : 'disconnected' })
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

const server = app.listen(PORT, '0.0.0.0', () => log('HTTP server listening on port ' + PORT))

function scheduleReconnect() {
  if (stopping || reconnectTimer || !MC_HOST) return
  const delay = reconnectDelay
  log('Next Minecraft connection attempt in ' + Math.round(delay / 1000) + ' seconds.')
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectMinecraft()
  }, delay)
  reconnectDelay = Math.min(reconnectDelay * 2, 60000)
}

function clearTrollTimers() {
  if (trollTimer) clearTimeout(trollTimer)
  if (returnTimer) clearTimeout(returnTimer)
  if (verifyTimer) clearTimeout(verifyTimer)
  trollTimer = null
  returnTimer = null
  verifyTimer = null
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

function teleportTo(position, reason, callback) {
  if (!bot || !position) {
    log('Teleport cancelled: missing bot or destination (' + reason + ').')
    if (callback) callback(false)
    return
  }

  const destination = new Vec3(Math.floor(position.x) + 0.5, Math.floor(position.y), Math.floor(position.z) + 0.5)
  const command = '/tp ' + bot.username + ' ' + destination.x.toFixed(1) + ' ' + destination.y.toFixed(1) + ' ' + destination.z.toFixed(1)
  log('Teleport requested: ' + reason + '; destination=' + destination.toString() + '; command=' + command)
  bot.chat(command)

  if (verifyTimer) clearTimeout(verifyTimer)
  verifyTimer = setTimeout(() => {
    verifyTimer = null
    if (!bot?.entity) {
      log('Teleport could not be verified: bot entity unavailable (' + reason + ').')
      if (callback) callback(false)
      return
    }

    const actual = bot.entity.position
    const distance = actual.distanceTo(destination)
    if (distance <= 2.5) {
      log('Teleport verified: ' + reason + '; actual=' + actual.toString())
      if (callback) callback(true)
    } else {
      lastError = 'Teleport not confirmed for ' + reason + '. Actual position: ' + actual.toString()
      log('TELEPORT NOT CONFIRMED: ' + lastError + '. Check OP, command feedback and server logs.')
      if (callback) callback(false)
    }
  }, 1500)
}

function returnToPreviousPosition(reason) {
  if (!connected || !bot || !previousPosition || returning) return
  returning = true
  clearTrollTimers()
  currentAction = 'returning'
  log('Returning to saved position: ' + reason)
  const destination = previousPosition.clone()
  const target = currentTarget
  if (target) playerCooldowns.set(target, Date.now() + 45000)

  teleportTo(destination, 'return to original position', () => {
    if (!connected) return
    currentAction = 'waiting'
    currentTarget = null
    previousPosition = null
    apparitionPosition = null
    targetStartPosition = null
    returning = false
    scheduleTroll(3500 + Math.floor(Math.random() * 5000))
  })
}

function isSafeStandingPosition(x, z, groundY) {
  const ground = bot.blockAt(new Vec3(x, groundY, z))
  const feet = bot.blockAt(new Vec3(x, groundY + 1, z))
  const head = bot.blockAt(new Vec3(x, groundY + 2, z))
  if (!ground || !feet || !head) return false
  if (ground.boundingBox !== 'block') return false
  if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') return false
  const forbidden = block => /water|lava|fire|campfire|magma|cactus|powder_snow|sweet_berry|pointed_dripstone/i.test(block.name)
  return !forbidden(ground) && !forbidden(feet) && !forbidden(head)
}

function findVisibleSafePosition(target) {
  const entity = target.entity
  const yaw = entity.yaw
  const pitch = entity.pitch
  const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
  const side = new Vec3(-direction.z, 0, direction.x)
  const distances = []

  for (let distance = MIN_APPEAR_DISTANCE; distance <= MAX_APPEAR_DISTANCE; distance += 1) distances.push(distance)
  for (let i = distances.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[distances[i], distances[j]] = [distances[j], distances[i]]
  }

  for (const distance of distances) {
    for (const sideOffset of [0, 1, -1, 2, -2]) {
      const point = entity.position.offset(direction.x * distance + side.x * sideOffset, 0, direction.z * distance + side.z * sideOffset)
      const x = Math.floor(point.x)
      const z = Math.floor(point.z)
      const baseY = Math.floor(entity.position.y)

      for (const yOffset of [0, -1, 1, -2, 2]) {
        const groundY = baseY + yOffset - 1
        if (isSafeStandingPosition(x, z, groundY)) return new Vec3(x + 0.5, groundY + 1, z + 0.5)
      }
    }
  }
  return null
}

function playerIsLookingAtHerobrine(entity) {
  if (!entity || !apparitionPosition) return false
  const eye = entity.position.offset(0, 1.62, 0)
  const delta = apparitionPosition.offset(0, 1.0, 0).minus(eye)
  const length = Math.sqrt(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z)
  if (!length) return true
  const yaw = entity.yaw
  const pitch = entity.pitch
  const view = new Vec3(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
  const dot = (view.x * delta.x + view.y * delta.y + view.z * delta.z) / length
  return dot >= LOOK_DOT_THRESHOLD
}

function recordPlayerWalkScore(username, score) {
  const now = Date.now()
  const previous = playerActivity.get(username)
  if (!previous || previous.walkScore !== score) {
    playerActivity.set(username, { walkScore: score, lastMovedAt: now })
  } else {
    previous.walkScore = score
  }
}

let positionPollTimer = null
let positionQueryTimeout = null
let pendingPositionQuery = null
let positionQueryIndex = 0

function schedulePositionPoll(delay = 1000) {
  if (!connected || !bot || stopping) return
  if (positionPollTimer) clearTimeout(positionPollTimer)
  positionPollTimer = setTimeout(() => {
    positionPollTimer = null
    pollRemotePlayerPositions()
  }, delay)
}

function pollRemotePlayerPositions() {
  if (!connected || !bot || stopping || pendingPositionQuery) {
    schedulePositionPoll(1000)
    return
  }

  const usernames = Object.keys(bot.players).filter(username =>
    username !== bot.username && /^[A-Za-z0-9_]{1,16}$/.test(username)
  )

  for (const username of playerActivity.keys()) {
    if (!bot.players[username]) playerActivity.delete(username)
  }

  if (!usernames.length) {
    schedulePositionPoll(2000)
    return
  }

  positionQueryIndex %= usernames.length
  const username = usernames[positionQueryIndex]
  positionQueryIndex = (positionQueryIndex + 1) % usernames.length
  pendingPositionQuery = username
  log('Querying walk statistic of ' + username + ' through the server.')
  bot.chat('/scoreboard players get ' + username + ' ht_walk')

  positionQueryTimeout = setTimeout(() => {
    if (pendingPositionQuery !== username) return
    pendingPositionQuery = null
    positionQueryTimeout = null
    log('Walk statistic query timed out for ' + username + '. Check that the ht_walk objective exists and Herobrine has permission to use commands.')
    schedulePositionPoll(1000)
  }, 3000)
}

function handlePositionResponse(message) {
  if (!pendingPositionQuery) return
  const username = pendingPositionQuery
  const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = message.match(new RegExp('(?:^|\\s)' + escapedUsername + '\\s+has\\s+(-?\\d+)\\s+\\[ht_walk\\]'))
  if (!match) return

  if (positionQueryTimeout) clearTimeout(positionQueryTimeout)
  positionQueryTimeout = null
  pendingPositionQuery = null
  recordPlayerWalkScore(username, Number(match[1]))
  schedulePositionPoll(400)
}

function samplePlayerActivity() {
  if (!bot?.entity) return

  if (currentAction === 'appearing' && currentTarget && apparitionPosition && targetStartPosition) {
    const target = bot.players[currentTarget]?.entity
    if (!target) {
      returnToPreviousPosition('target left the server')
      return
    }
    if (playerIsLookingAtHerobrine(target)) {
      log(currentTarget + ' is looking at Herobrine. Vanishing now.')
      returnToPreviousPosition('the player looked at Herobrine')
      return
    }
    const startDistance = targetStartPosition.distanceTo(apparitionPosition)
    const currentDistance = target.position.distanceTo(apparitionPosition)
    if (startDistance - currentDistance >= 0.8) {
      log(currentTarget + ' approached Herobrine. Vanishing now.')
      returnToPreviousPosition('the player approached')
    }
  }
}

function findIdleTarget() {
  if (!bot?.entity) return null
  const now = Date.now()
  let best = null
  let longestIdle = 0

  for (const [username, activity] of playerActivity.entries()) {
    if (!bot.players[username] || username === bot.username) continue
    if ((now - activity.lastMovedAt) / 1000 < IDLE_SECONDS) continue
    if ((playerCooldowns.get(username) || 0) > now) continue
    const idleFor = now - activity.lastMovedAt
    if (idleFor <= longestIdle) continue
    best = { username, idleFor }
    longestIdle = idleFor
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
  if (!bot?.entity || !target?.username) return

  previousPosition = bot.entity.position.clone()
  currentTarget = target.username
  currentAction = 'preparing'
  log('Target selected: ' + target.username + '; idle for ' + Math.floor(target.idleFor / 1000) + ' seconds. Teleporting to load target chunks.')
  log('Teleporting Herobrine directly to ' + target.username + '.')
  bot.chat('/tp ' + bot.username + ' ' + target.username)

  setTimeout(() => {
    if (!connected || currentAction !== 'preparing') return
    const refreshedTarget = bot.players[target.username]
    if (!refreshedTarget?.entity) {
      log('Could not load ' + target.username + ' after the player teleport.')
      playerCooldowns.set(target.username, Date.now() + 15000)
      returnToPreviousPosition('target entity did not load after teleport')
      return
    }

    const safePosition = findVisibleSafePosition(refreshedTarget)
    if (!safePosition) {
      log('No safe solid block found near ' + target.username + ' after loading target chunks.')
      returnToPreviousPosition('no safe apparition position was found')
      return
    }

    targetStartPosition = refreshedTarget.entity.position.clone()
    apparitionPosition = safePosition
    currentAction = 'appearing'
    log('Trying to appear in ' + target.username + ' view at ' + safePosition.toString())

    teleportTo(apparitionPosition, 'appear in front of ' + target.username, appeared => {
      if (!connected || currentAction !== 'appearing') return
      if (!appeared) {
        playerCooldowns.set(target.username, Date.now() + 15000)
        returnToPreviousPosition('apparition teleport failed')
        return
      }
      returnTimer = setTimeout(() => returnToPreviousPosition('five-second appearance ended'), APPEAR_SECONDS * 1000)
    })
  }, 1800)
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
  log('Connecting to ' + MC_HOST + ':' + MC_PORT + ' with Minecraft ' + MC_VERSION + '...')

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
    log('Could not create Minecraft bot: ' + error.message)
    scheduleReconnect()
    return
  }

  bot.on('login', () => log('Minecraft login successful.'))
  bot.on('messagestr', (message, position) => {
    handlePositionResponse(message)
    log('Server message [' + (position || 'unknown') + ']: ' + message)
  })

  bot.once('spawn', () => {
    connected = true
    lastError = null
    lastConnectedAt = new Date().toISOString()
    reconnectDelay = 5000
    playerActivity.clear()
    playerCooldowns.clear()
    pendingPositionQuery = null
    positionQueryIndex = 0
    if (positionPollTimer) clearTimeout(positionPollTimer)
    if (positionQueryTimeout) clearTimeout(positionQueryTimeout)
    positionPollTimer = null
    positionQueryTimeout = null
    resetTrollState()
    log('Herobrine has entered the world.')
    schedulePositionPoll(1000)
    if (TROLL_ENABLED) {
      log('Teleport scare behavior enabled. Remote position polling is active.')
      scheduleTroll(1500)
    }
  })

  bot.on('physicsTick', samplePlayerActivity)
  bot.on('kicked', reason => {
    connected = false
    lastError = typeof reason === 'string' ? reason : JSON.stringify(reason)
    log('Herobrine was kicked: ' + lastError)
    resetTrollState()
  })
  bot.on('error', error => {
    lastError = error.message
    log('Minecraft connection error: ' + error.message)
  })
  bot.once('end', reason => {
    connected = false
    resetTrollState()
    if (positionPollTimer) clearTimeout(positionPollTimer)
    if (positionQueryTimeout) clearTimeout(positionQueryTimeout)
    positionPollTimer = null
    positionQueryTimeout = null
    pendingPositionQuery = null
    playerActivity.clear()
    log('Herobrine disconnected: ' + (reason || 'connection ended'))
    bot = null
    scheduleReconnect()
  })
}

if (!MC_HOST) {
  lastError = 'MC_HOST is not configured'
  log('Missing MC_HOST environment variable. HTTP status server is running.')
} else {
  connectMinecraft()
}

function shutdown(signal) {
  if (stopping) return
  stopping = true
  log('Received ' + signal + '. Shutting down...')
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
