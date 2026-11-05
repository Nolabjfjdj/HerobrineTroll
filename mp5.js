const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { plugin: pvp } = require('mineflayer-pvp')

module.exports = function startMp5({ mineflayer, host, port, version, owner }) {
  const username = 'JeSuisUnBot'
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
  let followTarget = null
  let lookTargetId = null
  let lookUntil = 0
  let lastLookAt = 0
  let ignoredLookEntityId = null
  let activeTask = null
  let taskGeneration = 0
  let eatingFood = false
  let fleeingMobId = null
  let fleeingUntil = 0
  let mobTargetId = null
  let lastNoFoodWarningAt = 0
  let lastMovementPosition = null
  let lastMovementCheckAt = 0
  let lastJumpAt = 0
  let jumpReleaseTimer = null
  const authorizedPlayers = new Set([owner, 'Itzhugoo12'])
  const protectedPlayers = new Set(Array.from(authorizedPlayers, player => player.toLowerCase()))
  const rememberedPositions = new Map()
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
    const match = message.trim().match(/^donne(?:\s+tout)?(?:\s+(.+))?$/i)
    if (!match) return null
    let query = normalizeItemText(match[1] || '')
    query = query
      .replace(/\b(que tu as|que t as|dans ton inventaire|dans inventaire|de ton inventaire|stp|svp)\b/g, ' ')
      .replace(/\b(le|la|les|du|de|des|un|une|l)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    query = canonicalItemText(query)
    return { query }
  }

  const itemAliases = {
    torche: 'torch',
    torches: 'torch',
    torch: 'torch',
    lit: 'bed',
    lits: 'bed',
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
    coffres: 'chest',
    planches: 'planks',
    terre: 'dirt',
    pierre: 'stone',
    bois: 'wood'
  }

  function canonicalItemText(value) {
    return normalizeItemText(value).split(' ').map(word => itemAliases[word] || word).join(' ')
  }

  function itemMatchesQuery(item, query) {
    if (!query) return true
    const canonicalQuery = canonicalItemText(query)
    const words = canonicalQuery.split(' ').filter(Boolean)
    const names = [item.name, item.displayName].filter(Boolean).map(canonicalItemText)
    return names.some(name => words.every(word => name.includes(word)))
  }

  async function giveRequestedItems() {
    if (!connected || !bot || !giveRequest || givingItems) return
    givingItems = true
    const request = giveRequest
    giveRequest = null
    try {
      if (bot.entity?.equipment?.[1]) {
        try {
          await bot.unequip('off-hand')
          log('Moved off-hand item into inventory before giving items.')
        } catch (error) {
          log('Could not move off-hand item into inventory: ' + error.message)
        }
      }
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
      log('Transferred ' + transferred + ' item(s) for ' + request.requester + '.')
    } catch (error) {
      log('Could not give items: ' + error.message)
      if (connected && bot) bot.chat('Je n’ai pas réussi à te donner les objets.')
    } finally {
      givingItems = false
      if (connected && bot && followTarget) {
        const target = bot.players[followTarget]?.entity
        if (target) {
          bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
          log('Resuming follow mode for ' + followTarget + ' after item delivery.')
        } else {
          followTarget = null
          bot.pathfinder.setGoal(null)
        }
      }
    }
  }

  function updateIdleLook() {
    if (!bot || !connected || !bot.entity) return
    if (giveRequest || givingItems || followTarget || playerTarget || bot.pathfinder?.goal) {
      lookTargetId = null
      ignoredLookEntityId = null
      return
    }
    const origin = bot.entity.position
    const nearby = Object.values(bot.entities)
      .filter(entity =>
        entity.id !== bot.entity.id &&
        (entity.type === 'player' || entity.type === 'mob') &&
        entity.position &&
        entity.position.distanceTo(origin) <= 4.5
      )
      .sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin))[0]
    if (!nearby) {
      lookTargetId = null
      ignoredLookEntityId = null
      return
    }
    const now = Date.now()
    if (lookTargetId !== nearby.id) {
      if (ignoredLookEntityId === nearby.id) return
      lookTargetId = nearby.id
      lookUntil = now + 2500
      lastLookAt = 0
    }
    if (now >= lookUntil) {
      ignoredLookEntityId = nearby.id
      lookTargetId = null
      return
    }
    if (now - lastLookAt >= 400) {
      lastLookAt = now
      const eyeTarget = nearby.position.offset(0, Math.min(nearby.height || 1.2, 1.6), 0)
      bot.lookAt(eyeTarget).catch(error => log('Could not look at nearby entity: ' + error.message))
    }
  }

  async function tryAutoEat() {
    if (!connected || !bot || eatingFood || bot.food > 14 || bot.currentWindow) return
    const foodPriority = [
      'golden_carrot',
      'cooked_beef',
      'cooked_porkchop',
      'cooked_mutton',
      'cooked_chicken',
      'cooked_rabbit',
      'cooked_salmon',
      'cooked_cod',
      'baked_potato',
      'bread',
      'pumpkin_pie',
      'cooked_fish',
      'apple',
      'carrot',
      'melon_slice',
      'sweet_berries',
      'glow_berries',
      'beetroot',
      'dried_kelp'
    ]
    const inventory = bot.inventory.items()
    let food = null
    for (const name of foodPriority) {
      food = inventory.find(item => item.name === name)
      if (food) break
    }
    if (!food) {
      if (Date.now() - lastNoFoodWarningAt > 60000) {
        lastNoFoodWarningAt = Date.now()
        log('Hungry, but no suitable food is available in the inventory.')
      }
      return
    }
    eatingFood = true
    const previousHeldItem = bot.heldItem
    try {
      await bot.equip(food, 'hand')
      await bot.consume()
      log('Automatically ate ' + food.name + '. Food level: ' + bot.food + '/20.')
    } catch (error) {
      log('Automatic eating failed: ' + error.message)
    } finally {
      if (connected && bot && previousHeldItem) {
        const itemToRestore = bot.inventory.items().find(item => item.type === previousHeldItem.type)
        if (itemToRestore) {
          try {
            await bot.equip(itemToRestore, 'hand')
          } catch (error) {
            log('Could not restore held item after eating: ' + error.message)
          }
        }
      }
      eatingFood = false
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
    mobTargetId = null
  }

  function isNearLadder() {
    if (!bot?.entity?.position) return false
    const position = bot.entity.position.floored()
    for (let x = -2; x <= 2; x++) {
      for (let y = -2; y <= 2; y++) {
        for (let z = -2; z <= 2; z++) {
          if (Math.abs(x) + Math.abs(z) > 2) continue
          const block = bot.blockAt(position.offset(x, y, z))
          if (block?.name === 'ladder') return true
        }
      }
    }
    return false
  }

  function handleStuckMovement() {
    if (!connected || !bot?.entity?.position || !bot.pathfinder?.goal || bot.currentWindow || givingItems || eatingFood) {
      if (jumpReleaseTimer) clearTimeout(jumpReleaseTimer)
      jumpReleaseTimer = null
      if (bot && connected) bot.setControlState('jump', false)
      lastMovementPosition = bot?.entity?.position?.clone() || null
      lastMovementCheckAt = Date.now()
      return
    }
    const now = Date.now()
    const position = bot.entity.position
    if (!isNearLadder()) {
      if (jumpReleaseTimer) clearTimeout(jumpReleaseTimer)
      jumpReleaseTimer = null
      bot.setControlState('jump', false)
      lastMovementPosition = position.clone()
      lastMovementCheckAt = now
      return
    }
    if (!lastMovementPosition) {
      lastMovementPosition = position.clone()
      lastMovementCheckAt = now
      return
    }
    if (position.distanceTo(lastMovementPosition) >= 0.35) {
      lastMovementPosition = position.clone()
      lastMovementCheckAt = now
      return
    }
    if (now - lastMovementCheckAt < 1400 || now - lastJumpAt < 1800) return
    lastJumpAt = now
    lastMovementPosition = position.clone()
    lastMovementCheckAt = now
    try {
      bot.setControlState('jump', true)
      if (jumpReleaseTimer) clearTimeout(jumpReleaseTimer)
      jumpReleaseTimer = setTimeout(() => {
        if (bot && connected) bot.setControlState('jump', false)
        jumpReleaseTimer = null
      }, 300)
      log('Movement blocked near a ladder. Trying to jump over the obstacle.')
    } catch (error) {
      log('Could not trigger ladder recovery jump: ' + error.message)
    }
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

  function isHostileMob(entity) {
    return Boolean(entity && entity.type === 'mob' && entity.name !== 'wolf' &&
      /zombie|skeleton|creeper|spider|enderman|witch|slime|phantom|drowned|husk|stray|pillager|vindicator|ravager|evoker|blaze|ghast|hoglin|piglin|warden|silverfish|guardian|shulker|vex|breeze|bogged|cave_spider|magma_cube|zoglin|wither_skeleton|zombified_piglin/i.test(entity.name || ''))
  }

  function fleeFromMob(entity, reason) {
    if (!connected || !bot || !entity?.position || !bot.entity?.position) return
    const now = Date.now()
    if (fleeingMobId === entity.id && now < fleeingUntil) return
    stopCombat()
    const origin = bot.entity.position
    let dx = origin.x - entity.position.x
    let dz = origin.z - entity.position.z
    let distance = Math.sqrt(dx * dx + dz * dz)
    if (distance < 0.01) {
      dx = Math.cos(bot.entity.yaw || 0)
      dz = Math.sin(bot.entity.yaw || 0)
      distance = Math.sqrt(dx * dx + dz * dz) || 1
    }
    const escapeDistance = entity.name === 'creeper' ? 18 : 12
    const targetX = Math.floor(origin.x + dx / distance * escapeDistance)
    const targetZ = Math.floor(origin.z + dz / distance * escapeDistance)
    fleeingMobId = entity.id
    fleeingUntil = now + 2500
    bot.pathfinder.setGoal(new goals.GoalNear(targetX, Math.floor(origin.y), targetZ, 2))
    log('Fleeing from ' + entity.name + ' (' + reason + ').')
  }

  function bestCombatWeapon() {
    const priorities = [
      'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
      'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'
    ]
    const inventory = bot.inventory.items()
    for (const name of priorities) {
      const weapon = inventory.find(item => item.name === name)
      if (weapon) return weapon
    }
    return null
  }

  async function engageMob(entity, reason) {
    if (!connected || !bot || !isHostileMob(entity) || !entity.position) return
    if (entity.name === 'creeper') {
      fleeFromMob(entity, reason + ': creeper')
      return
    }
    if (bot.health !== undefined && bot.health <= 8) {
      fleeFromMob(entity, reason + ': low health')
      return
    }
    if (mobTargetId === entity.id) return
    stopCombat()
    mobTargetId = entity.id
    fleeingMobId = null
    try {
      const weapon = bestCombatWeapon()
      if (weapon) {
        await bot.equip(weapon, 'hand')
        if (!connected || !bot || mobTargetId !== entity.id || !bot.entities[entity.id]) return
        log('Equipped ' + weapon.name + ' to defend against ' + entity.name + '.')
      }
      const result = bot.pvp.attack(entity)
      if (result && typeof result.catch === 'function') {
        result.catch(error => {
          if (mobTargetId === entity.id) mobTargetId = null
          log('Could not fight ' + entity.name + ': ' + error.message)
        })
      }
      log('Fighting hostile mob ' + entity.name + ' (' + reason + ').')
    } catch (error) {
      if (mobTargetId === entity.id) mobTargetId = null
      log('Could not prepare for combat with ' + entity.name + ': ' + error.message)
    }
  }

  function attackMob(entity, reason) {
    engageMob(entity, reason)
  }

  function handleVisibleThreats() {
    if (!connected || !bot?.entity?.position || bot.currentWindow || givingItems) return
    const nearby = Object.values(bot.entities).filter(entity =>
      isHostileMob(entity) && entity.position &&
      entity.position.distanceTo(bot.entity.position) <= (entity.name === 'creeper' ? 12 : 7)
    ).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    if (nearby.length) {
      const creeper = nearby.find(entity => entity.name === 'creeper')
      if (creeper) {
        fleeFromMob(creeper, 'nearby creeper detected')
        return
      }
      const threat = nearby[0]
      if (bot.health !== undefined && bot.health <= 8) {
        fleeFromMob(threat, 'low health')
        return
      }
      engageMob(threat, 'nearby hostile mob detected')
      return
    }
    if (mobTargetId !== null && !bot.entities[mobTargetId]) {
      mobTargetId = null
      try {
        bot.pvp.stop()
      } catch {}
      if (followTarget) {
        const target = bot.players[followTarget]?.entity
        if (target) bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      }
    }
    if (fleeingMobId !== null && Date.now() >= fleeingUntil) {
      const previousThreat = bot.entities[fleeingMobId]
      if (!previousThreat?.position || previousThreat.position.distanceTo(bot.entity.position) > 12) {
        fleeingMobId = null
        if (followTarget) {
          const target = bot.players[followTarget]?.entity
          if (target) bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
        }
      }
    }
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
      entity.position.distanceTo(ownerEntity.position) <= 6
    )
    nearby.sort((a, b) => a.position.distanceTo(ownerEntity.position) - b.position.distanceTo(ownerEntity.position))
    const recentPlayer = nearby.find(entity =>
      entity.type === 'player' &&
      now - (swingTimes.get(entity.id) || 0) <= 2200
    )
    if (recentPlayer) return recentPlayer
    return nearby.find(isHostileMob) || null
  }

  function isLogBlock(block) {
    return Boolean(block && /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|crimson|warped)_log$/.test(block.name))
  }

  function isOutsideProtectedAreas(position, protectedAreas, radius = 32) {
    return protectedAreas.every(area => {
      if (area.dimension !== bot.game.dimension) return true
      const dx = position.x - area.x
      const dz = position.z - area.z
      return Math.sqrt(dx * dx + dz * dz) >= radius
    })
  }

  function findRemoteWorkPoint(protectedAreas) {
    if (!bot?.entity?.position) return null
    const origin = bot.entity.position.floored()
    const directions = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1]
    ]
    for (const distance of [40, 48, 56, 64, 72]) {
      for (const [dx, dz] of directions) {
        const length = Math.sqrt(dx * dx + dz * dz)
        const x = Math.floor(origin.x + dx / length * distance)
        const z = Math.floor(origin.z + dz / length * distance)
        for (let yOffset = 8; yOffset >= -12; yOffset--) {
          const candidate = origin.offset(x - origin.x, yOffset, z - origin.z)
          if (!isOutsideProtectedAreas(candidate, protectedAreas, 32)) continue
          const feet = bot.blockAt(candidate)
          const head = bot.blockAt(candidate.offset(0, 1, 0))
          const floor = bot.blockAt(candidate.offset(0, -1, 0))
          if (feet?.name === 'air' && head?.name === 'air' && floor?.boundingBox === 'block') return candidate
        }
      }
    }
    return null
  }

  function findTreeLogs(protectedAreas = []) {
    const groundNames = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|moss_block|mud|muddy_mangrove_roots)$/
    const leavesPattern = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|azalea|flowering_azalea|pale_oak)_leaves$/
    const positions = bot.findBlocks({ matching: block => isLogBlock(block), maxDistance: 24, count: 100 })
    const bases = positions.map(position => bot.blockAt(position)).filter(block => {
      if (!block || !isOutsideProtectedAreas(block.position, protectedAreas, 32)) return false
      if (!groundNames.test(bot.blockAt(block.position.offset(0, -1, 0))?.name || '')) return false
      let height = 0
      while (height < 12 && isLogBlock(bot.blockAt(block.position.offset(0, height, 0)))) height++
      if (height < 2) return false
      for (let y = height - 1; y <= height + 4; y++) {
        for (let x = -5; x <= 5; x++) {
          for (let z = -5; z <= 5; z++) {
            const nearby = bot.blockAt(block.position.offset(x, y, z))
            if (nearby && leavesPattern.test(nearby.name)) return true
          }
        }
      }
      return false
    }).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    if (!bases.length) return []
    const base = bases[0]
    const logs = []
    for (let height = 0; height < 12; height++) {
      const block = bot.blockAt(base.position.offset(0, height, 0))
      if (!isLogBlock(block)) break
      logs.push(block.position.clone())
    }
    return logs
  }

  function findOreBlock() {
    const orePattern = /^(coal_ore|deepslate_coal_ore|iron_ore|deepslate_iron_ore|copper_ore|deepslate_copper_ore|gold_ore|deepslate_gold_ore|redstone_ore|deepslate_redstone_ore|lapis_ore|deepslate_lapis_ore|diamond_ore|deepslate_diamond_ore|emerald_ore|deepslate_emerald_ore|nether_gold_ore|nether_quartz_ore|ancient_debris)$/
    const positions = bot.findBlocks({ matching: block => Boolean(block && orePattern.test(block.name)), maxDistance: 32, count: 80 })
    return positions.map(position => bot.blockAt(position))
      .filter(block => block && orePattern.test(block.name))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null
  }

  function findNearbyChest() {
    const chestNames = new Set(['chest', 'trapped_chest'])
    const positions = bot.findBlocks({
      matching: block => Boolean(block && chestNames.has(block.name)),
      maxDistance: 32,
      count: 30
    })
    return positions
      .map(position => bot.blockAt(position))
      .filter(block => block && chestNames.has(block.name))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null
  }

  async function runChestTask(action, query) {
    if (activeTask) {
      bot.chat('Je suis déjà occupé. Dis-moi « arrête » pour annuler.')
      return
    }
    const generation = ++taskGeneration
    activeTask = 'chest'
    followTarget = null
    giveRequest = null
    stopCombat()
    bot.chat(action === 'deposit'
      ? 'Je cherche un coffre pour y ranger les objets.'
      : 'Je cherche un coffre pour récupérer cet objet.')
    let container = null
    let transferred = 0
    try {
      const chest = findNearbyChest()
      if (!chest) {
        bot.chat('Je ne trouve aucun coffre à proximité.')
        return
      }
      await bot.pathfinder.goto(new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2))
      if (!connected || !bot || taskGeneration !== generation) return
      const currentChest = bot.blockAt(chest.position)
      if (!currentChest || !['chest', 'trapped_chest'].includes(currentChest.name)) {
        bot.chat('Le coffre n’est plus accessible.')
        return
      }
      container = await bot.openContainer(currentChest)
      if (!connected || !bot || taskGeneration !== generation) return
      if (action === 'deposit') {
        const items = bot.inventory.items().filter(item => !query || itemMatchesQuery(item, query))
        for (const item of items) {
          if (!connected || !bot || taskGeneration !== generation) break
          const current = bot.inventory.items().find(entry =>
            entry.type === item.type &&
            entry.metadata === item.metadata &&
            itemMatchesQuery(entry, query)
          )
          if (!current) continue
          await container.deposit(current.type, current.metadata ?? null, current.count)
          transferred += current.count
        }
      } else {
        const items = container.slots
          .slice(0, container.inventoryStart)
          .filter(item => item && itemMatchesQuery(item, query))
        for (const item of items) {
          if (!connected || !bot || taskGeneration !== generation) break
          await container.withdraw(item.type, item.metadata ?? null, item.count)
          transferred += item.count
        }
      }
      if (connected && bot && taskGeneration === generation) {
        if (transferred > 0) {
          bot.chat(action === 'deposit'
            ? 'C’est rangé. J’ai déposé ' + transferred + ' objet(s).'
            : 'Voilà. J’ai récupéré ' + transferred + ' objet(s).')
        } else {
          bot.chat(action === 'deposit'
            ? 'Je n’ai trouvé aucun objet correspondant dans mon inventaire.'
            : 'Je n’ai pas trouvé cet objet dans le coffre.')
        }
      }
    } catch (error) {
      if (connected && bot && taskGeneration === generation) {
        log('Chest task failed: ' + error.message)
        bot.chat('Je n’ai pas réussi à utiliser le coffre.')
      }
    } finally {
      if (container) {
        try {
          await container.close()
        } catch (error) {
          log('Could not close chest window: ' + error.message)
        }
      }
      if (taskGeneration === generation) activeTask = null
    }
  }

  function stopActiveTask() {
    if (!activeTask) return false
    taskGeneration++
    activeTask = null
    try {
      bot.pathfinder.setGoal(null)
      bot.stopDigging()
    } catch {}
    return true
  }

  function waitForHarvest(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async function craftItem(itemName, count, table = null) {
    const item = bot.registry.itemsByName[itemName]
    if (!item) return false
    const recipes = bot.recipesFor(item.id, null, 1, table)
    if (!recipes.length) return false
    await bot.craft(recipes[0], count, table)
    return true
  }

  async function ensureHarvestTool(kind) {
    const names = kind === 'wood'
      ? ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe']
      : ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe']
    let tool = bot.inventory.items().find(item => names.includes(item.name))
    if (tool) {
      await bot.equip(tool, 'hand')
      return true
    }

    const logs = bot.inventory.items().filter(item => /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|crimson|warped)_log$/.test(item.name))
    if (logs.length && !bot.inventory.items().some(item => item.name.endsWith('_planks'))) {
      const plankName = logs[0].name.replace('_log', '_planks')
      await craftItem(plankName, 1)
    }
    let planks = bot.inventory.items().find(item => item.name.endsWith('_planks'))
    if (planks && !bot.inventory.items().some(item => item.name === 'stick')) {
      await craftItem('stick', 1)
    }

    let table = bot.findBlock({
      matching: block => block.name === 'crafting_table',
      maxDistance: 4
    })
    if (!table && bot.inventory.items().some(item => item.name === 'crafting_table')) {
      const origin = bot.entity.position.floored()
      const spots = [
        origin.offset(1, 0, 0), origin.offset(-1, 0, 0),
        origin.offset(0, 0, 1), origin.offset(0, 0, -1)
      ]
      for (const spot of spots) {
        const floor = bot.blockAt(spot.offset(0, -1, 0))
        if (bot.blockAt(spot)?.name !== 'air' || bot.blockAt(spot.offset(0, 1, 0))?.name !== 'air' || floor?.boundingBox !== 'block') continue
        try {
          await bot.placeBlock(floor, spot.minus(floor.position))
          table = bot.blockAt(spot)
          break
        } catch (error) {
          log('Could not place crafting table: ' + error.message)
        }
      }
    }
    if (!table && planks) {
      if (await craftItem('crafting_table', 1)) {
        const origin = bot.entity.position.floored()
        const spots = [
          origin.offset(1, 0, 0), origin.offset(-1, 0, 0),
          origin.offset(0, 0, 1), origin.offset(0, 0, -1)
        ]
        for (const spot of spots) {
          const floor = bot.blockAt(spot.offset(0, -1, 0))
          if (bot.blockAt(spot)?.name !== 'air' || bot.blockAt(spot.offset(0, 1, 0))?.name !== 'air' || floor?.boundingBox !== 'block') continue
          try {
            await bot.placeBlock(floor, spot.minus(floor.position))
            table = bot.blockAt(spot)
            break
          } catch (error) {
            log('Could not place crafting table: ' + error.message)
          }
        }
      }
    }

    const pickaxeMaterials = kind === 'wood'
      ? ['diamond', 'iron', 'stone', 'wooden']
      : ['diamond', 'iron', 'stone', 'wooden']
    for (const material of pickaxeMaterials) {
      const itemName = material + (kind === 'wood' ? '_axe' : '_pickaxe')
      if (material === 'wooden') {
        planks = bot.inventory.items().find(item => item.name.endsWith('_planks'))
        if (!planks) continue
      } else if (material === 'stone') {
        if (!bot.inventory.items().some(item => ['cobblestone', 'cobbled_deepslate', 'blackstone'].includes(item.name))) continue
      } else if (!bot.inventory.items().some(item => item.name === material + '_ingot' || item.name === material + '_gem')) {
        continue
      }
      if (!table) continue
      try {
        if (await craftItem(itemName, 1, table)) {
          tool = bot.inventory.items().find(item => item.name === itemName)
          if (tool) {
            await bot.equip(tool, 'hand')
            bot.chat('J’ai fabriqué ' + itemName.replace('_', ' ') + ' pour continuer.')
            return true
          }
        }
      } catch (error) {
        log('Could not craft ' + itemName + ': ' + error.message)
      }
    }
    return false
  }

  function isMineableTunnelBlock(block) {
    return Boolean(block && (
      /^(stone|granite|diorite|andesite|deepslate|tuff|calcite|dripstone_block|cobblestone|cobbled_deepslate|dirt|coarse_dirt|gravel|clay|netherrack|blackstone|basalt|smooth_basalt|nether_quartz_ore|nether_gold_ore|ancient_debris)$/.test(block.name) ||
      /^(coal|iron|copper|gold|redstone|lapis|diamond|emerald)_ore$/.test(block.name) ||
      /^deepslate_(coal|iron|copper|gold|redstone|lapis|diamond|emerald)_ore$/.test(block.name)
    ))
  }

  async function digIfSafe(position, protectedAreas, kind) {
    if (!isOutsideProtectedAreas(position, protectedAreas, 32)) return false
    const block = bot.blockAt(position)
    if (!block || block.name === 'air') return true
    if (!isMineableTunnelBlock(block) && !(kind === 'wood' && isLogBlock(block))) return false
    if (!bot.canDigBlock(block)) return false
    const tool = bot.pathfinder.bestHarvestTool(block)
    if (tool && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand')
    await bot.dig(block)
    return true
  }

  async function mineStaircase(protectedAreas, generation) {
    const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    let direction = directions[Math.floor(Math.random() * directions.length)]
    let steps = 0
    let toolReady = await ensureHarvestTool('mine')
    if (!toolReady) {
      bot.chat('Il me manque de quoi fabriquer une pioche. Ajoute du bois, des bâtons et de la pierre ou du métal dans mon inventaire.')
      while (connected && bot && activeTask === 'mine' && taskGeneration === generation && !toolReady) {
        await waitForHarvest(5000)
        toolReady = await ensureHarvestTool('mine')
      }
    }
    while (connected && bot && activeTask === 'mine' && taskGeneration === generation) {
      const position = bot.entity.position.floored()
      const next = position.offset(direction[0], -1, direction[1])
      if (!isOutsideProtectedAreas(next, protectedAreas, 32)) {
        direction = directions[(directions.indexOf(direction) + 1) % directions.length]
        continue
      }
      const landingFloor = bot.blockAt(next.offset(0, -1, 0))
      if (!landingFloor || landingFloor.boundingBox !== 'block' || /water|lava/.test(landingFloor.name)) {
        direction = directions[(directions.indexOf(direction) + 1) % directions.length]
        continue
      }
      const feetBlock = bot.blockAt(next)
      const headBlock = bot.blockAt(next.offset(0, 1, 0))
      if ([feetBlock, headBlock].some(block => block && /water|lava/.test(block.name))) {
        direction = directions[(directions.indexOf(direction) + 1) % directions.length]
        continue
      }
      if (!await digIfSafe(next, protectedAreas, 'mine')) {
        direction = directions[(directions.indexOf(direction) + 1) % directions.length]
        continue
      }
      if (!await digIfSafe(next.offset(0, 1, 0), protectedAreas, 'mine')) {
        direction = directions[(directions.indexOf(direction) + 1) % directions.length]
        continue
      }
      if (!connected || !bot || activeTask !== 'mine' || taskGeneration !== generation) break
      await bot.pathfinder.goto(new goals.GoalNear(next.x, next.y, next.z, 1))
      if (!connected || !bot || activeTask !== 'mine' || taskGeneration !== generation) break
      steps++
      if (steps % 8 === 0) {
        const ore = findOreBlock()
        if (ore && ore.position.distanceTo(bot.entity.position) <= 4 && isOutsideProtectedAreas(ore.position, protectedAreas, 32)) {
          await digIfSafe(ore.position, protectedAreas, 'mine')
        }
        toolReady = await ensureHarvestTool('mine')
        if (!toolReady) {
          bot.chat('Je n’ai plus de pioche utilisable et je ne peux pas en fabriquer une avec mon inventaire.')
          await waitForHarvest(5000)
        }
      }
    }
  }

  async function runHarvestTask(kind) {
    if (activeTask) {
      bot.chat('Je suis déjà occupé. Dis-moi « arrête » pour annuler.')
      return
    }
    const generation = ++taskGeneration
    activeTask = kind
    followTarget = null
    stopCombat()
    const protectedAreas = [{
      x: bot.entity.position.x,
      z: bot.entity.position.z,
      dimension: bot.game.dimension
    }, ...Array.from(rememberedPositions.values())
      .filter(position => position.dimension === bot.game.dimension)
      .map(position => ({ x: position.x, z: position.z, dimension: position.dimension }))]
    bot.chat(kind === 'wood'
      ? 'Je pars chercher du bois loin des positions protégées. Je continuerai jusqu’à ce que tu me dises d’arrêter.'
      : 'Je pars loin des positions protégées pour creuser une mine en escalier. Je continuerai jusqu’à ce que tu me dises d’arrêter.')
    let harvested = 0
    let treeQueue = []
    try {
      const remotePoint = findRemoteWorkPoint(protectedAreas)
      if (remotePoint) {
        await bot.pathfinder.goto(new goals.GoalNear(remotePoint.x, remotePoint.y, remotePoint.z, 3))
      } else {
        bot.chat('Je ne trouve pas de zone sûre assez éloignée. Mémorise la maison ou déplace-moi plus loin.')
        while (connected && bot && activeTask === kind && taskGeneration === generation) await waitForHarvest(3000)
      }
      if (kind === 'mine' && connected && bot && activeTask === kind && taskGeneration === generation) {
        await mineStaircase(protectedAreas, generation)
      }
      while (kind === 'wood' && connected && bot && activeTask === kind && taskGeneration === generation) {
        if (!treeQueue.length) treeQueue = findTreeLogs(protectedAreas)
        if (!treeQueue.length) {
          const nextPoint = findRemoteWorkPoint(protectedAreas)
          if (nextPoint) {
            await bot.pathfinder.goto(new goals.GoalNear(nextPoint.x, nextPoint.y, nextPoint.z, 3))
            await waitForHarvest(1200)
          } else {
            await waitForHarvest(3000)
          }
          continue
        }
        const targetPosition = treeQueue.shift()
        if (!targetPosition || !isOutsideProtectedAreas(targetPosition, protectedAreas, 32)) continue
        await bot.pathfinder.goto(new goals.GoalNear(targetPosition.x, targetPosition.y, targetPosition.z, 2))
        if (!connected || !bot || activeTask !== kind || taskGeneration !== generation) break
        const currentBlock = bot.blockAt(targetPosition)
        if (!currentBlock || !isLogBlock(currentBlock)) continue
        if (!bot.canDigBlock(currentBlock)) {
          log('Cannot reach tree log ' + currentBlock.name + '.')
          treeQueue = []
          continue
        }
        if (!await ensureHarvestTool('wood')) {
          log('No axe could be crafted; continuing with the available hand tool.')
        }
        await bot.dig(currentBlock)
        harvested++
      }
    } catch (error) {
      if (connected && bot && taskGeneration === generation) {
        log('Harvest task failed: ' + error.message)
        bot.chat('J’ai rencontré un problème et je réessaie de continuer.')
        await waitForHarvest(1500)
      }
    } finally {
      if (taskGeneration === generation) activeTask = null
    }
  }

  function handleChat(usernameFromChat, message) {
    if (usernameFromChat === username || !connected || !bot) return
    const normalizedOwnerCommand = message.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    if (usernameFromChat.toLowerCase() === String(owner).toLowerCase()) {
      const protectMatch = normalizedOwnerCommand.match(/^protege\s+([A-Za-z0-9_]{1,16})$/i)
      const unprotectMatch = normalizedOwnerCommand.match(/^arrete de proteger\s+([A-Za-z0-9_]{1,16})$/i)
      if (protectMatch) {
        const targetName = protectMatch[1]
        const key = targetName.toLowerCase()
        if (protectedPlayers.has(key)) bot.chat(targetName + ' est déjà dans ma liste de protection.')
        else {
          protectedPlayers.add(key)
          bot.chat('D’accord, je protégerai ' + targetName + '.')
          log('Protection enabled for ' + targetName + '.')
        }
        return
      }
      if (unprotectMatch) {
        const targetName = unprotectMatch[1]
        const key = targetName.toLowerCase()
        if (!protectedPlayers.has(key)) bot.chat(targetName + ' n’est pas dans ma liste de protection.')
        else {
          protectedPlayers.delete(key)
          bot.chat('D’accord, je ne protégerai plus ' + targetName + '.')
          log('Protection disabled for ' + targetName + '.')
        }
        return
      }
    }
    const normalizedMessage = message.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    const rememberMatch = normalizedMessage.match(/^memorise\s+(.{1,32})$/i)
    const goPositionMatch = normalizedMessage.match(/^va a\s+(.{1,32})$/i)
    const forgetPositionMatch = normalizedMessage.match(/^oublie\s+(.{1,32})$/i)
    const normalizePositionName = value => value.trim().replace(/\s+/g, ' ').toLowerCase()
    if (rememberMatch) {
      const name = rememberMatch[1].trim().replace(/\s+/g, ' ')
      if (!name || !bot.entity?.position) {
        bot.chat('Je ne peux pas enregistrer cette position maintenant.')
        return
      }
      rememberedPositions.set(normalizePositionName(name), {
        name,
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z),
        dimension: bot.game.dimension
      })
      bot.chat('Position « ' + name + ' » mémorisée.')
      return
    }
    if (normalizedMessage === 'positions' || normalizedMessage === 'liste positions') {
      const saved = Array.from(rememberedPositions.values())
      bot.chat(saved.length
        ? 'Positions : ' + saved.map(position => position.name).join(', ')
        : 'Je n’ai aucune position mémorisée.')
      return
    }
    if (forgetPositionMatch) {
      const name = forgetPositionMatch[1].trim().replace(/\s+/g, ' ')
      const key = normalizePositionName(name)
      if (rememberedPositions.delete(key)) bot.chat('Position « ' + name + ' » oubliée.')
      else bot.chat('Je ne connais pas la position « ' + name + ' ».')
      return
    }
    if (goPositionMatch) {
      const name = goPositionMatch[1].trim().replace(/\s+/g, ' ')
      const position = rememberedPositions.get(normalizePositionName(name))
      if (!position) {
        bot.chat('Je ne connais pas la position « ' + name + ' ».')
        return
      }
      if (position.dimension !== bot.game.dimension) {
        bot.chat('Cette position est dans une autre dimension.')
        return
      }
      if (activeTask) {
        bot.chat('Je suis déjà occupé. Dis-moi « arrête » avant de changer de destination.')
        return
      }
      followTarget = null
      giveRequest = null
      stopCombat()
      bot.pathfinder.setGoal(new goals.GoalNear(position.x, position.y, position.z, 1))
      bot.chat('Je vais à la position « ' + position.name + ' ».')
      return
    }

    {
      const depositAllMatch = normalizedMessage.match(/^range (?:tout|mon inventaire|mes objets)$/i)
      const depositItemMatch = normalizedMessage.match(/^range (.{1,32})$/i)
      const withdrawMatch = normalizedMessage.match(/^prends (.{1,32})$/i)
      if (depositAllMatch) {
        runChestTask('deposit', '')
        return
      }
      if (depositItemMatch) {
        runChestTask('deposit', canonicalItemText(depositItemMatch[1]))
        return
      }
      if (withdrawMatch) {
        runChestTask('withdraw', canonicalItemText(withdrawMatch[1]))
        return
      }
    }
    {
      const request = parseGiveRequest(message)
      if (request) {
        if (giveRequest || givingItems) {
          bot.chat('Attends, je termine déjà de donner des objets.')
          return
        }
        const requesterEntity = bot.players[usernameFromChat]?.entity
        if (!requesterEntity) {
          bot.chat('Je ne te vois pas. Reviens près de moi.')
          return
        }
        giveRequest = { ...request, requester: usernameFromChat }
        bot.chat('J’arrive pour te donner ça.')
        bot.pathfinder.setGoal(new goals.GoalFollow(requesterEntity, 2), true)
        return
      }
    }
    {
      const followMatch = message.trim().match(/^suis\s+([A-Za-z0-9_]{1,16})$/i)
      if (followMatch && followMatch[1].toLowerCase() !== 'moi') {
        const targetName = followMatch[1]
        const target = bot.players[targetName]?.entity
        if (!target) {
          bot.chat('Je ne vois pas ce joueur. Vérifie son pseudo et assure-toi qu’il est connecté.')
          return
        }
        giveRequest = null
        followTarget = target.username || targetName
        stopCombat()
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
        bot.chat('Ok, je suis maintenant ' + followTarget + '.')
        return
      }
      const taskCommand = message.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-'’]+/g, '')
      if (['vacouperdubois', 'vacasserdubois', 'vacouperdesarbres', 'vaabattredesarbres'].includes(taskCommand)) {
        runHarvestTask('wood')
        return
      }
      if (['vaminer', 'mine', 'vaextrairedesminerais'].includes(taskCommand)) {
        runHarvestTask('mine')
        return
      }
      if (['arrete', 'stop', 'annule'].includes(taskCommand)) {
        if (stopActiveTask()) bot.chat('D’accord, j’arrête la tâche en cours.')
        else bot.chat('Je ne suis pas en train de récolter.')
        return
      }
      const normalizedCommand = message.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-'’]+/g, '')
      if (normalizedCommand === 'suismoi' || normalizedCommand === 'viens') {
        const target = bot.players[usernameFromChat]?.entity
        if (!target) {
          bot.chat('Je ne te vois pas. Rapproche-toi.')
          return
        }
        giveRequest = null
        followTarget = usernameFromChat
        stopCombat()
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
        bot.chat('J’arrive, je te suis.')
        return
      }
      if (normalizedCommand === 'resteici' || normalizedCommand === 'bougepas') {
        followTarget = null
        giveRequest = null
        stopCombat()
        bot.pathfinder.setGoal(null)
        bot.chat('Ok, je reste ici.')
        return
      }
    }
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
    bot.on('entityHurt', hurtEntity => {
      if (!hurtEntity) return
      if (hurtEntity.id === bot.entity?.id) {
        const attacker = findNearbyAttacker(bot.entity)
        if (!attacker) {
          log('MP5 was hurt, but the attacker could not be identified nearby.')
          return
        }
        if (attacker.type === 'player') {
          const attackerName = String(attacker.username || attacker.name || '').toLowerCase()
          if (protectedPlayers.has(attackerName)) {
            log('MP5 was hit by protected player ' + (attacker.username || attacker.name) + '; no retaliation.')
          } else {
            punchPlayer(attacker)
          }
          return
        }
        if (attacker.type === 'mob') {
          attackMob(attacker, 'defending MP5')
        }
        return
      }
      const hurtPlayer = hurtEntity.username
      if (protectedPlayers.has(String(hurtPlayer || '').toLowerCase())) {
        log(hurtPlayer + ' was hurt. Checking for a nearby hostile mob.')
        const attacker = findNearbyAttacker(bot.players[hurtPlayer]?.entity)
        if (attacker) handleAttacker(attacker, 'defending ' + hurtPlayer)
        else log('Could not identify the attacker near ' + hurtPlayer + '.')
        return
      }
    })
    bot.on('physicsTick', () => {
      tryAutoEat()
      if (giveRequest && !givingItems && connected && bot) {
        const requesterEntity = bot.players[giveRequest.requester]?.entity
        if (!requesterEntity) {
          giveRequest = null
          bot.pathfinder.setGoal(null)
          bot.chat('Je ne te trouve plus, réessaie.')
        } else if (bot.entity?.position?.distanceTo(requesterEntity.position) <= 3.2) {
          bot.pathfinder.setGoal(null)
          giveRequestedItems()
        }
        return
      }
      handleVisibleThreats()
      handleStuckMovement()
      updateIdleLook()
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
      lastMovementPosition = bot.entity.position.clone()
      lastMovementCheckAt = Date.now()
      lastJumpAt = 0
      recentAttacker = null
      recentAttackerAt = 0
      const movements = new Movements(bot)
      movements.canDig = false
      movements.canOpenDoors = true
      movements.allow1by1towers = false
      movements.scafoldingBlocks = []
      const isWoodenDoorBlock = block => Boolean(block && /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|crimson|warped)_door$/.test(block.name))
      const isWoodenTrapdoorBlock = block => Boolean(block && /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|pale_oak|crimson|warped)_trapdoor$/.test(block.name))
      for (const block of bot.registry.blocksArray) {
        if (isWoodenDoorBlock(block) || isWoodenTrapdoorBlock(block)) movements.openable.add(block.id)
      }
      const originalGetBlock = movements.getBlock.bind(movements)
      movements.getBlock = function (pos, dx, dy, dz) {
        const block = originalGetBlock(pos, dx, dy, dz)
        if (isWoodenDoorBlock(block)) {
          const properties = block.getProperties?.() || block._properties || {}
          const lowerBlock = properties.half === 'upper' ? bot.blockAt(block.position.offset(0, -1, 0)) : block
          const lowerProperties = lowerBlock?.getProperties?.() || lowerBlock?._properties || {}
          block.openable = lowerProperties.open !== true
        } else if (isWoodenTrapdoorBlock(block)) {
          const properties = block.getProperties?.() || block._properties || {}
          block.openable = properties.open !== true
        }
        return block
      }
      const originalSafeOrBreak = movements.safeOrBreak.bind(movements)
      movements.safeOrBreak = function (block, toBreak) {
        if (isWoodenDoorBlock(block) || isWoodenTrapdoorBlock(block)) {
          return this.exclusionStep(block) + this.getNumEntitiesAt(block.position, 0, 0, 0) * this.entityCost
        }
        return originalSafeOrBreak(block, toBreak)
      }
      bot.pathfinder.setMovements(movements)
      log('Connected. Authorized players: ' + Array.from(authorizedPlayers).join(', ') + '. Follow, combat and item commands are active. Block breaking is disabled.')
    })
    bot.on('kicked', reason => {
      connected = false
      log('Kicked: ' + (typeof reason === 'string' ? reason : JSON.stringify(reason)))
      stopCombat()
    })
    bot.on('error', error => log('Connection error: ' + error.message))
    bot.once('end', reason => {
      connected = false
      if (jumpReleaseTimer) clearTimeout(jumpReleaseTimer)
      jumpReleaseTimer = null
      stopCombat()
      swingTimes.clear()
      giveRequest = null
      givingItems = false
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
