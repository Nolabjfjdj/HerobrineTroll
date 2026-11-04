const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { plugin: pvp } = require('mineflayer-pvp')

module.exports = function startMp5({ mineflayer, host, port, version, owner }) {
  const username = 'mp5_123'
  let bot = null
  let connected = false
  let stopping = false
  let reconnectTimer = null
  let reconnectDelay = 5000
  let recentAttacker = null
  let recentAttackerAt = 0
  let playerTarget = null
  let playerHitPending = false
  let giveRequest = null
  let givingItems = false
  const swingTimes = new Map()

  function log(message) {
    console.log('[mp5_123] ' + message)
  }

  function normalizeItemText(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/minecraft:/g, '')
      .replace(/[_-]+/g, ' ')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function parseGiveRequest(message) {
    const match = message.trim().match(/^donne\s+(?:tout\s+)?(.+)?$/i)
    if (!match) return null
    let query = normalizeItemText(match[1] || '')
    query = query
      .replace(/\b(que tu as|que t as|dans ton inventaire|dans inventaire|de ton inventaire|stp|svp)\b/g, ' ')
      .replace(/\b(le|la|les|du|de|des|un|une|l)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const aliases = {
      lit: 'bed',
      rouge: 'red',
      bleu: 'blue',
      vert: 'green',
      blanc: 'white',
      noir: 'black',
      jaune: 'yellow',
      orange: 'orange',
      violet: 'purple',
      rose: 'pink',
      gris: 'gray',
      marron: 'brown',
      coffre: 'chest',
      planches: 'planks',
      terre: 'dirt',
      pierre: 'stone',
      bois: 'wood'
    }
    query = query.split(' ').map(word => aliases[word] || word).join(' ').trim()
    return { query }
  }

  function itemMatchesQuery(item, query) {
    if (!query) return true
    const names = [
      normalizeItemText(item.name),
      normalizeItemText(item.displayName)
    ]
    const words = query.split(' ').filter(Boolean)
    return names.some(name => words.every(word => name.includes(word)))
  }

  async function giveRequestedItems() {
    if (!connected || !bot || !giveRequest || givingItems) return
    givingItems = true
    const request = giveRequest
    giveRequest = null
    try {
      const items = bot.inventory.items().filter(item => itemMatchesQuery(item, request.query))
      if (!items.length) {
        bot.chat(request.query ? 'Je ne trouve pas cet objet dans mon inventaire.' : 'Mon inventaire est vide.')
        return
      }
      let transferred = 0
      for (const item of items) {
        if (!connected || !bot) break
        const current = bot.inventory.items().find(entry => entry.type === item.type)
        if (!current) continue
        await bot.tossStack(current)
        transferred += current.count
      }
      if (transferred > 0) bot.chat('Tiens, je t’ai donné ' + transferred + ' objet(s).')
      else bot.chat('Je n’ai rien pu te donner.')
      log('Transferred ' + transferred + ' item(s) to ' + owner + '.')
    } catch (error) {
      log('Could not give items: ' + error.message)
      if (connected && bot) bot.chat('Je n’ai pas réussi à te donner les objets.')
    } finally {
      givingItems = false
    }
  }

  function stopCombat() {
    if (!bot) return
    try {
      bot.pvp.stop()
    } catch {}
    try {
      bot.pathfinder.setGoal(null)
    } catch {}
    playerTarget = null
    playerHitPending = false
  }

  function scheduleReconnect() {
    if (stopping || reconnectTimer || !host) return
    const delay = reconnectDelay
    log('Next connection attempt in ' + Math.round(delay / 1000) + ' seconds.')
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
    reconnectDelay = Math.min(reconnectDelay * 2, 60000)
  }

  function punchPlayer(entity) {
    if (!connected || !bot || !entity || entity.type !== 'player') return
    stopCombat()
    playerTarget = entity
    playerHitPending = true
    bot.unequip('hand').then(() => {
      if (!connected || !bot || playerTarget !== entity) return
      bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
      log('Following ' + (entity.username || entity.name) + ' to deliver one bare-hand hit.')
    }).catch(error => log('Could not empty hand: ' + error.message))
  }

  function attackMob(entity, reason) {
    if (!connected || !bot || !entity || entity.type !== 'mob' || entity.name === 'wolf') return
    stopCombat()
    log('Attacking ' + entity.name + ' with an empty hand (' + reason + ').')
    bot.unequip('hand').then(() => {
      if (connected && bot) bot.pvp.attack(entity)
    }).catch(error => log('Could not empty hand before defending: ' + error.message))
  }

  function handleAttacker(entity, reason) {
    if (!entity || !entity.position || entity.name === 'wolf') return
    recentAttacker = entity
    recentAttackerAt = Date.now()
    if (entity.type === 'player') {
      punchPlayer(entity)
      return
    }
    if (entity.type === 'mob') attackMob(entity, reason)
  }

  function findNearbyAttacker(ownerEntity) {
    if (!bot || !ownerEntity) return null
    const now = Date.now()
    const nearby = Object.values(bot.entities).filter(entity =>
      entity.id !== ownerEntity.id &&
      entity.position &&
      entity.position.distanceTo(ownerEntity.position) <= 5 &&
      now - (swingTimes.get(entity.id) || 0) <= 2200
    )
    nearby.sort((a, b) => a.position.distanceTo(ownerEntity.position) - b.position.distanceTo(ownerEntity.position))
    const player = nearby.find(entity => entity.type === 'player')
    if (player) return player
    const mob = nearby.find(entity => entity.type === 'mob' && entity.name !== 'wolf')
    if (mob) return mob
    const hostileNames = /zombie|skeleton|creeper|spider|enderman|witch|slime|phantom|drowned|husk|stray|pillager|vindicator|ravager|evoker|blaze|ghast|hoglin|piglin|warden|silverfish|guardian|shulker|vex|breeze|bogged|cave_spider/i
    return Object.values(bot.entities)
      .filter(entity => entity.type === 'mob' && entity.name !== 'wolf' && hostileNames.test(entity.name || '') && entity.position && entity.position.distanceTo(ownerEntity.position) <= 4)
      .sort((a, b) => a.position.distanceTo(ownerEntity.position) - b.position.distanceTo(ownerEntity.position))[0] || null
  }

  function handleChat(usernameFromChat, message) {
    if (usernameFromChat === username || !connected || !bot) return
    const normalized = message.trim().toLowerCase().replace(/[\s-]+/g, '')
    if (normalized === 'weshananas') {
      bot.chat('Ouais c’est moi')
      return
    }
    if (normalized === 'aidenous') {
      bot.chat('Non')
      return
    }
    if (normalized === 'tuele') {
      if (!recentAttacker || Date.now() - recentAttackerAt > 15000 || !bot.entities[recentAttacker.id]) {
        bot.chat('Je ne vois personne à attaquer.')
        return
      }
      handleAttacker(recentAttacker, 'chat command')
    }
  }

  function connect() {
    if (stopping || !host) return
    log('Connecting to ' + host + ':' + port + ' as ' + username + '...')
    try {
      bot = mineflayer.createBot({ host, port, username, auth: 'offline', version })
    } catch (error) {
      log('Could not create bot: ' + error.message)
      scheduleReconnect()
      return
    }

    bot.loadPlugin(pathfinder)
    bot.loadPlugin(pvp)
    bot.on('chat', handleChat)
    bot.on('entitySwingArm', entity => {
      if (entity?.id !== undefined) swingTimes.set(entity.id, Date.now())
    })
    bot.on('entityHurt', (hurtEntity, source) => {
      if (hurtEntity?.username !== owner) return
      log(owner + ' was hurt. Damage source: ' + (source?.username || source?.name || 'not identified') + '.')
      const attacker = source?.position ? source : findNearbyAttacker(bot.players[owner]?.entity)
      if (attacker) handleAttacker(attacker, 'defending ' + owner)
      else log('Could not identify the attacker near ' + owner + '.')
    })
    bot.on('physicsTick', () => {
      if (!connected || !bot || !playerTarget || !playerHitPending) return
      const target = playerTarget
      if (!bot.entities[target.id] || !target.position || !bot.entity?.position) {
        stopCombat()
        return
      }
      if (bot.entity.position.distanceTo(target.position) <= 3.2) {
        playerHitPending = false
        bot.pathfinder.setGoal(null)
        bot.attack(target)
        log('Delivered one bare-hand hit to ' + (target.username || target.name) + '.')
        playerTarget = null
      }
    })
    bot.once('spawn', () => {
      connected = true
      reconnectDelay = 5000
      swingTimes.clear()
      recentAttacker = null
      recentAttackerAt = 0
      bot.pathfinder.setMovements(new Movements(bot))
      log('Connected. Chat replies and damage detection are active.')
    })
    bot.on('kicked', reason => {
      connected = false
      log('Kicked: ' + (typeof reason === 'string' ? reason : JSON.stringify(reason)))
      stopCombat()
    })
    bot.on('error', error => log('Connection error: ' + error.message))
    bot.once('end', reason => {
      connected = false
      stopCombat()
      swingTimes.clear()
      log('Disconnected: ' + (reason || 'connection ended'))
      bot = null
      scheduleReconnect()
    })
  }

  connect()

  return {
    stop() {
      stopping = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      stopCombat()
      if (bot) {
        try {
          bot.quit('mp5_123 is restarting')
        } catch {}
      }
    }
  }
}


if (require.main === module) {
  const mineflayer = require('mineflayer')
  const express = require('express')
  const app = express()
  const PORT = Number(process.env.PORT || 10000)
  const MC_HOST = process.env.MC_HOST
  const MC_PORT = Number(process.env.MC_PORT || 25565)
  const MC_VERSION = process.env.MC_VERSION || '1.21.4'
  const OWNER = process.env.MP5_OWNER || 'NolanLaBanane415'
  let controller = null

  app.get('/', (req, res) => {
    res.type('html').send('<main><h1>MP5</h1><p>MP5 Minecraft bot service is running.</p><p><a href="/health">Health</a></p></main>')
  })

  app.get('/health', (req, res) => {
    res.status(200).json({ http: 'online', service: 'mp5_123', minecraft: controller ? 'started' : 'not_started' })
  })

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('[mp5_123] HTTP health server listening on port ' + PORT)
  })

  if (!MC_HOST) {
    console.error('[mp5_123] Missing MC_HOST environment variable. Set it in Render.')
  } else {
    controller = module.exports({ mineflayer, host: MC_HOST, port: MC_PORT, version: MC_VERSION, owner: OWNER })
  }

  function shutdown(signal) {
    console.log('[mp5_123] Received ' + signal + '. Shutting down...')
    if (controller) controller.stop()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 10000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
