const mineflayer = require('mineflayer')
const express = require('express')

const app = express()
const PORT = Number(process.env.PORT || 10000)
const MC_HOST = process.env.MC_HOST
const MC_PORT = Number(process.env.MC_PORT || 25565)
const MC_VERSION = process.env.MC_VERSION || '1.21.4'

let bot = null
let connected = false
let lastError = null
let reconnectTimer = null
let reconnectDelay = 5000
let stopping = false
let lastConnectedAt = null

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
    console.log('Herobrine has entered the world.')
  })

  bot.on('kicked', reason => {
    connected = false
    lastError = typeof reason === 'string' ? reason : JSON.stringify(reason)
    console.log('Herobrine was kicked:', lastError)
  })

  bot.on('error', error => {
    lastError = error.message
    console.error('Minecraft connection error:', error.message)
  })

  bot.once('end', reason => {
    connected = false
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
