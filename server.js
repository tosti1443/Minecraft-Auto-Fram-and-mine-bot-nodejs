const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const {
  pathfinder,
  Movements,
  goals: { GoalNear },
} = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, 'bots.json');

const NON_MINEABLE = new Set([
  'air',
  'cave_air',
  'void_air',
  'water',
  'lava',
  'bedrock',
  'nether_portal',
  'end_portal',
  'end_portal_frame',
]);

/** @type {Map<string, any>} */
const bots = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function defaultMinerConfig() {
  return {
    area: null,
    columns: [],
    chest: null,
    minToolDurability: 20,
    placeChestsInCorner: false,
  };
}

function defaultMinerState(config = defaultMinerConfig()) {
  return {
    running: false,
    stopRequested: false,
    minedBlocks: 0,
    lastAction: 'idle',
    prevMovements: null,
    blockedTargets: new Map(),
    lastTargetKey: null,
    sameTargetStreak: 0,
    layerPlan: null,
    autoChestPos: null,
    config,
  };
}

function defaultFarmerConfig() {
  return {
    area: null,
    chest: null,
  };
}

function defaultFarmerState(config = defaultFarmerConfig()) {
  return {
    running: false,
    stopRequested: false,
    harvested: 0,
    planted: 0,
    lastAction: 'idle',
    prevMovements: null,
    config,
  };
}

function normalizeMinerConfig(input = {}) {
  const minToolDurabilityRaw = Number(input.minToolDurability);
  const minToolDurability = Number.isFinite(minToolDurabilityRaw) ? Math.max(1, Math.floor(minToolDurabilityRaw)) : 20;
  const placeChestsInCorner = input.placeChestsInCorner === true;

  let area = null;
  if (input.area && typeof input.area === 'object') {
    const x1 = Math.floor(Number(input.area.x1));
    const x2 = Math.floor(Number(input.area.x2));
    const z1 = Math.floor(Number(input.area.z1));
    const z2 = Math.floor(Number(input.area.z2));
    const yMin = Math.floor(Number(input.area.yMin));
    const yMax = Math.floor(Number(input.area.yMax));
    if ([x1, x2, z1, z2, yMin, yMax].every(Number.isFinite)) {
      area = {
        x1: Math.min(x1, x2),
        x2: Math.max(x1, x2),
        z1: Math.min(z1, z2),
        z2: Math.max(z1, z2),
        yMin: Math.min(yMin, yMax),
        yMax: Math.max(yMin, yMax),
      };
    }
  }

  let chest = null;
  if (input.chest && typeof input.chest === 'object') {
    const x = Math.floor(Number(input.chest.x));
    const y = Math.floor(Number(input.chest.y));
    const z = Math.floor(Number(input.chest.z));
    if ([x, y, z].every(Number.isFinite)) chest = { x, y, z };
  }

  const columns = columnsFromSelection(input.columns);

  return { area, columns, chest, minToolDurability, placeChestsInCorner };
}

function normalizeFarmerConfig(input = {}) {
  let area = null;
  if (input.area && typeof input.area === 'object') {
    const x1 = Math.floor(Number(input.area.x1));
    const x2 = Math.floor(Number(input.area.x2));
    const z1 = Math.floor(Number(input.area.z1));
    const z2 = Math.floor(Number(input.area.z2));
    const yMin = Math.floor(Number(input.area.yMin));
    const yMax = Math.floor(Number(input.area.yMax));
    if ([x1, x2, z1, z2, yMin, yMax].every(Number.isFinite)) {
      area = {
        x1: Math.min(x1, x2),
        x2: Math.max(x1, x2),
        z1: Math.min(z1, z2),
        z2: Math.max(z1, z2),
        yMin: Math.min(yMin, yMax),
        yMax: Math.max(yMin, yMax),
      };
    }
  }

  let chest = null;
  if (input.chest && typeof input.chest === 'object') {
    const x = Math.floor(Number(input.chest.x));
    const y = Math.floor(Number(input.chest.y));
    const z = Math.floor(Number(input.chest.z));
    if ([x, y, z].every(Number.isFinite)) chest = { x, y, z };
  }

  return { area, chest };
}

function normalizeProfileName(name, fallback) {
  const raw = String(name || '').trim();
  if (!raw) return fallback;
  return raw.slice(0, 60);
}
function normalizeMinerProfiles(list = []) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const config = normalizeMinerConfig(item.config || {});
    if (!config.area) continue;
    out.push({
      id: String(item.id || createId()),
      name: normalizeProfileName(item.name, `Miner ${out.length + 1}`),
      config,
    });
  }
  return out;
}
function normalizeFarmerProfiles(list = []) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const config = normalizeFarmerConfig(item.config || {});
    if (!config.area) continue;
    out.push({
      id: String(item.id || createId()),
      name: normalizeProfileName(item.name, `Farmer ${out.length + 1}`),
      config,
    });
  }
  return out;
}

function createBotItem(entry) {
  const minerConfig = normalizeMinerConfig(entry?.minerConfig || {});
  const farmerConfig = normalizeFarmerConfig(entry?.farmerConfig || {});
  const minerProfiles = normalizeMinerProfiles(entry?.minerProfiles || []);
  const farmerProfiles = normalizeFarmerProfiles(entry?.farmerProfiles || []);
  return {
    id: String(entry?.id || createId()),
    name: String(entry?.name || entry?.username || 'Bot'),
    username: String(entry?.username || `bot_${Math.floor(Math.random() * 10000)}`),
    host: String(entry?.host || '127.0.0.1'),
    port: Number(entry?.port || 25565),
    version: String(entry?.version || '1.21.1'),
    auth: entry?.auth === 'microsoft' ? 'microsoft' : 'offline',
    connected: false,
    status: 'offline',
    coords: null,
    bot: null,
    miner: defaultMinerState(minerConfig),
    farmer: defaultFarmerState(farmerConfig),
    minerProfiles,
    farmerProfiles,
    preview: { map: '', updatedAt: null },
  };
}

function inventorySnapshot(bot) {
  if (!bot || !bot.inventory || typeof bot.inventory.items !== 'function') return [];
  return bot.inventory
    .items()
    .map((item) => ({
      name: item.name,
      count: item.count,
      slot: item.slot,
    }))
    .sort((a, b) => a.slot - b.slot)
    .slice(0, 54);
}

function safeBotView(botItem) {
  const bot = botItem.bot;
  const look = bot?.entity
    ? {
        yawDeg: Number(((bot.entity.yaw * 180) / Math.PI).toFixed(1)),
        pitchDeg: Number(((bot.entity.pitch * 180) / Math.PI).toFixed(1)),
      }
    : null;

  return {
    id: botItem.id,
    name: botItem.name,
    username: botItem.username,
    host: botItem.host,
    port: botItem.port,
    version: botItem.version,
    auth: botItem.auth,
    connected: botItem.connected,
    status: botItem.status,
    coords: botItem.coords,
    miner: {
      running: botItem.miner.running,
      stopRequested: botItem.miner.stopRequested,
      minedBlocks: botItem.miner.minedBlocks,
      lastAction: botItem.miner.lastAction,
      config: botItem.miner.config,
    },
    farmer: {
      running: botItem.farmer.running,
      stopRequested: botItem.farmer.stopRequested,
      harvested: botItem.farmer.harvested,
      planted: botItem.farmer.planted,
      lastAction: botItem.farmer.lastAction,
      config: botItem.farmer.config,
    },
    minerProfiles: botItem.minerProfiles,
    farmerProfiles: botItem.farmerProfiles,
    preview: botItem.preview,
    look,
    inventory: inventorySnapshot(bot),
    heldItem: bot?.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null,
  };
}

function emitBots() {
  io.emit('bots:update', Array.from(bots.values()).map(safeBotView));
}

function saveBotsToFile() {
  const data = Array.from(bots.values()).map((b) => ({
    id: b.id,
    name: b.name,
    username: b.username,
    host: b.host,
    port: b.port,
    version: b.version,
    auth: b.auth,
    minerConfig: b.miner.config,
    farmerConfig: b.farmer.config,
    minerProfiles: b.minerProfiles,
    farmerProfiles: b.farmerProfiles,
  }));
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function loadBotsFromFile() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const content = fs.readFileSync(DATA_FILE, 'utf8');
    const list = JSON.parse(content);
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      bots.set(String(entry.id || createId()), createBotItem(entry));
    }
  } catch (err) {
    console.error('Nie udalo sie wczytac bots.json:', err.message);
  }
}

function stopMiner(botItem, silent = false) {
  botItem.miner.stopRequested = true;
  configureMinerMovements(botItem, false);
  botItem.miner.running = false;
  if (!silent) {
    botItem.miner.lastAction = 'stop requested';
    botItem.status = 'miner stopped';
    emitBots();
  }
}

function stopFarmer(botItem, silent = false) {
  botItem.farmer.stopRequested = true;
  configureFarmerMovements(botItem, false);
    botItem.farmer.running = false;
  if (!silent) {
    botItem.farmer.lastAction = 'stop requested';
    botItem.status = 'farmer stopped';
    emitBots();
  }
}

function getPickaxes(bot) {
  if (!bot || !bot.inventory || typeof bot.inventory.items !== 'function') return [];

  return bot.inventory
    .items()
    .filter((item) => item.name.endsWith('_pickaxe'))
    .map((item) => {
      const max = typeof item.maxDurability === 'number' ? item.maxDurability : Number.MAX_SAFE_INTEGER;
      const used = typeof item.durabilityUsed === 'number' ? item.durabilityUsed : 0;
      return { item, remaining: max - used };
    })
    .sort((a, b) => b.remaining - a.remaining);
}

async function equipBestPickaxe(botItem) {
  const bot = botItem.bot;
  if (!bot) return false;

  const pickaxes = getPickaxes(bot);
  if (pickaxes.length === 0) {
    botItem.status = 'miner stop: brak kilofow';
    botItem.miner.lastAction = 'no pickaxe';
    notifyBotOnChat(botItem, '[BOT] Koniec kilofow, daj mi nowe kilofy.');
    emitBots();
    return false;
  }

  const best = pickaxes[0];
  if (best.remaining <= botItem.miner.config.minToolDurability) {
    botItem.status = `miner stop: niski durability (${best.remaining})`;
    botItem.miner.lastAction = 'low durability';
    notifyBotOnChat(botItem, '[BOT] Kilofy sa prawie zuzyte, daj mi nowe.');
    emitBots();
    return false;
  }

  if (!bot.heldItem || bot.heldItem.slot !== best.item.slot) {
    await bot.equip(best.item, 'hand');
  }

  return true;
}

function countEmptySlots(bot) {
  if (!bot || !bot.inventory) return 0;
  if (typeof bot.inventory.emptySlotCount === 'function') return bot.inventory.emptySlotCount();
  const slots = Array.isArray(bot.inventory.slots) ? bot.inventory.slots.slice(9, 45) : [];
  return slots.filter((v) => v == null).length;
}

function hasChestItem(bot) {
  if (!bot || !bot.inventory || typeof bot.inventory.items !== 'function') return null;
  return bot.inventory.items().find((it) => it.name === 'chest') || null;
}

function shouldDepositItems(botItem) {
  const bot = botItem.bot;
  if (!bot) return false;
  return countEmptySlots(bot) <= 2;
}
function notifyBotOnChat(botItem, message) {
  const bot = botItem.bot;
  if (!bot || !botItem.connected || typeof bot.chat !== 'function') return;
  try {
    bot.chat(message);
  } catch (_) {
    // Ignore chat errors.
  }
}

function isLavaBlock(block) {
  if (!block || !block.name) return false;
  return block.name.includes('lava');
}

function hasLavaAround(bot, pos) {
  const offsets = [
    new Vec3(0, 0, 0),
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
    new Vec3(0, 1, 0),
    new Vec3(0, -1, 0),
  ];

  for (const off of offsets) {
    const b = bot.blockAt(pos.plus(off));
    if (isLavaBlock(b)) return true;
  }
  return false;
}

async function moveNear(bot, x, y, z, range = 1, timeoutMs = 12000) {
  const goalPromise = bot.pathfinder.goto(new GoalNear(x, y, z, range));
  const timeoutPromise = sleep(timeoutMs).then(() => { throw new Error('path timeout'); });
  await Promise.race([goalPromise, timeoutPromise]);
}

async function waitForDigStart(bot, pos, timeoutMs = 4000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const t = bot.targetDigBlock;
    if (
      t &&
      t.position &&
      t.position.x === pos.x &&
      t.position.y === pos.y &&
      t.position.z === pos.z
    ) {
      return true;
    }
    await sleep(80);
  }
  return false;
}

function areaFromCurrentChunk(position, yMin, yMax, chunkRadius = 0) {
  const cx = Math.floor(position.x / 16);
  const cz = Math.floor(position.z / 16);
  const radius = Math.max(0, Math.floor(chunkRadius));
  const minChunkX = cx - radius;
  const maxChunkX = cx + radius;
  const minChunkZ = cz - radius;
  const maxChunkZ = cz + radius;
  return {
    x1: minChunkX * 16,
    x2: maxChunkX * 16 + 15,
    z1: minChunkZ * 16,
    z2: maxChunkZ * 16 + 15,
    yMin: Math.min(yMin, yMax),
    yMax: Math.max(yMin, yMax),
  };
}

function columnsFromSelection(selection = []) {
  const columns = [];
  const seen = new Set();
  if (!Array.isArray(selection)) return columns;
  for (const item of selection) {
    if (!item || typeof item !== 'object') continue;
    const x = Math.floor(Number(item.x));
    const z = Math.floor(Number(item.z));
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const key = `${x},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    columns.push({ x, z });
  }
  return columns;
}

function areaFromColumns(columns, yMin, yMax) {
  if (!columns.length) return null;
  let x1 = columns[0].x;
  let x2 = columns[0].x;
  let z1 = columns[0].z;
  let z2 = columns[0].z;
  for (const c of columns) {
    x1 = Math.min(x1, c.x);
    x2 = Math.max(x2, c.x);
    z1 = Math.min(z1, c.z);
    z2 = Math.max(z2, c.z);
  }
  return { x1, x2, z1, z2, yMin: Math.min(yMin, yMax), yMax: Math.max(yMin, yMax) };
}

function getModeConfig(botItem, mode) {
  return mode === 'farmer' ? botItem.farmer.config : botItem.miner.config;
}

function getModeState(botItem, mode) {
  return mode === 'farmer' ? botItem.farmer : botItem.miner;
}

async function tryPlaceAutoChest(botItem, mode = 'miner') {
  const bot = botItem.bot;
  const cfg = getModeConfig(botItem, mode);
  const state = getModeState(botItem, mode);
  const area = cfg.area;
  if (!bot || !area) return false;

  if (mode === 'miner' && cfg.placeChestsInCorner && state.autoChestPos) {
    const existing = bot.blockAt(new Vec3(state.autoChestPos.x, state.autoChestPos.y, state.autoChestPos.z));
    if (existing && (existing.name.includes('chest') || existing.name.includes('barrel'))) {
      cfg.chest = { x: state.autoChestPos.x, y: state.autoChestPos.y, z: state.autoChestPos.z };
      return true;
    }
    state.autoChestPos = null;
  }

  const chestItem = hasChestItem(bot);
  if (!chestItem) return false;

  const corners = [
    { x: area.x1, z: area.z1 },
    { x: area.x2, z: area.z1 },
    { x: area.x1, z: area.z2 },
    { x: area.x2, z: area.z2 },
  ];

  const baseY = Math.floor(bot.entity.position.y);

  for (const corner of corners) {
    for (let dy = 3; dy >= -10; dy -= 1) {
      const groundPos = new Vec3(corner.x, baseY + dy, corner.z);
      const abovePos = groundPos.offset(0, 1, 0);
      const ground = bot.blockAt(groundPos);
      const above = bot.blockAt(abovePos);
      if (!ground || !above) continue;
      if (ground.boundingBox !== 'block') continue;
      if (!(above.name === 'air' || above.name === 'cave_air' || above.name === 'void_air')) continue;

      try {
        await moveNear(bot, abovePos.x, abovePos.y, abovePos.z, 2);
        await bot.equip(chestItem, 'hand');
        await bot.placeBlock(ground, new Vec3(0, 1, 0));

        cfg.chest = { x: abovePos.x, y: abovePos.y, z: abovePos.z };
        if (mode === 'miner') state.autoChestPos = { x: abovePos.x, y: abovePos.y, z: abovePos.z };
        botItem.status = `${mode}: postawilem auto skrzynke @ ${abovePos.x} ${abovePos.y} ${abovePos.z}`;
        state.lastAction = 'auto chest placed';
        saveBotsToFile();
        emitBots();
        return true;
      } catch (_) {
        // Try next candidate.
      }
    }
  }

  return false;
}

async function depositItemsToChest(botItem, mode = 'miner') {
  const bot = botItem.bot;
  const cfg = getModeConfig(botItem, mode);
  const state = getModeState(botItem, mode);
  const forceAutoChest = mode === 'miner' && cfg.placeChestsInCorner === true;
  const chestPos = forceAutoChest ? state.autoChestPos : cfg.chest;
  if (!bot || !chestPos) return;
  state.lastAction = 'going to chest';
  botItem.status = `${mode}: odkladam itemy do skrzyni`;
  emitBots();
  await moveNear(bot, chestPos.x, chestPos.y, chestPos.z, 2);
  const chestBlock = bot.blockAt(new Vec3(chestPos.x, chestPos.y, chestPos.z));
  if (!chestBlock || (!chestBlock.name.includes('chest') && !chestBlock.name.includes('barrel'))) {
    botItem.status = `${mode}: nie widze skrzyni na podanych koordynatach`;
    state.lastAction = 'chest missing';
    emitBots();
    return;
  }
  let container = null;
  try {
    container = chestBlock.name.includes('chest') ? await bot.openChest(chestBlock) : await bot.openContainer(chestBlock);
    const keepByName = new Map();
    const neverDeposit = new Set(['chest', 'trapped_chest', 'barrel', 'shulker_box']);
    if (mode === 'farmer') {
      keepByName.set('wheat_seeds', 64);
      keepByName.set('potato', 64);
      keepByName.set('carrot', 64);
      keepByName.set('beetroot_seeds', 64);
    }
    const items = bot.inventory.items().slice().sort((a, b) => a.slot - b.slot);
    for (const item of items) {
      if (neverDeposit.has(item.name)) continue;
      let depositCount = item.count;
      const keep = keepByName.get(item.name) || 0;
      if (keep > 0) {
        const kept = Math.min(keep, item.count);
        keepByName.set(item.name, keep - kept);
        depositCount -= kept;
      }
      if (mode === 'miner' && item.name.endsWith('_pickaxe')) {
        const max = typeof item.maxDurability === 'number' ? item.maxDurability : Number.MAX_SAFE_INTEGER;
        const used = typeof item.durabilityUsed === 'number' ? item.durabilityUsed : 0;
        const remaining = max - used;
        if (remaining > botItem.miner.config.minToolDurability) depositCount = 0;
      }
      if (depositCount <= 0) continue;
      try {
        await container.deposit(item.type, null, depositCount);
      } catch (_) {
        // Chest may be full for this item.
      }
    }
  } finally {
    if (container) container.close();
  }
}
function isMineableBlock(block, botItem) {
  if (!block) return false;
  if (NON_MINEABLE.has(block.name)) return false;
  if (
    block.name.includes('chest') ||
    block.name.includes('barrel') ||
    block.name.includes('shulker_box')
  ) {
    return false;
  }

  const chest = botItem.miner.config.chest;
  if (chest && block.position.x === chest.x && block.position.y === chest.y && block.position.z === chest.z) return false;

  const bot = botItem.bot;
  if (!bot || !bot.canDigBlock(block)) return false;

  // Safety: do not dig the block directly under bot (no self-shaft).
  const bx = Math.floor(bot.entity.position.x);
  const by = Math.floor(bot.entity.position.y);
  const bz = Math.floor(bot.entity.position.z);
  if (block.position.x === bx && block.position.z === bz && block.position.y <= by - 1) return false;

  if (hasLavaAround(bot, block.position)) return false;

  return true;
}

function minerTargetKey(pos) {
  return `${pos.x},${pos.y},${pos.z}`;
}

function isTemporarilyBlockedTarget(botItem, pos) {
  const map = botItem?.miner?.blockedTargets;
  if (!(map instanceof Map)) return false;
  const key = minerTargetKey(pos);
  const until = map.get(key);
  if (!until) return false;
  if (Date.now() > until) {
    map.delete(key);
    return false;
  }
  return true;
}

function blockMinerTarget(botItem, pos, ms = 120000) {
  if (!botItem?.miner) return;
  if (!(botItem.miner.blockedTargets instanceof Map)) botItem.miner.blockedTargets = new Map();
  botItem.miner.lastTargetKey = null;
  botItem.miner.sameTargetStreak = 0;
  botItem.miner.layerPlan = null;
  botItem.miner.blockedTargets.set(minerTargetKey(pos), Date.now() + ms);
}

async function collectNearbyDrops(botItem, radius = 6) {
  const bot = botItem.bot;
  if (!bot?.entity?.position) return;

  for (let tries = 0; tries < 6; tries += 1) {
    const itemEntity = bot.nearestEntity((entity) => {
      if (!entity?.position) return false;
      if (entity.name !== 'item') return false;
      return bot.entity.position.distanceTo(entity.position) <= radius;
    });
    if (!itemEntity) return;

    try {
      await moveNear(bot, itemEntity.position.x, itemEntity.position.y, itemEntity.position.z, 1, 1800);
      await sleep(150);
    } catch (_) {
      return;
    }
  }
}

function findNextMineTarget(botItem) {
  const bot = botItem.bot;
  const area = botItem.miner.config.area;
  const columns = Array.isArray(botItem.miner.config.columns) ? botItem.miner.config.columns : [];
  if (!bot || !area) return null;
  const maxDigReach = 4.6;

  const range = (a, b, forward = true) => {
    const out = [];
    if (forward) {
      for (let v = a; v <= b; v += 1) out.push(v);
    } else {
      for (let v = b; v >= a; v -= 1) out.push(v);
    }
    return out;
  };

  const takeFromPlan = () => {
    const plan = botItem.miner.layerPlan;
    if (!plan || !Array.isArray(plan.queue)) return null;

    const scanCount = Math.min(plan.queue.length, 12);
    let reachableIndex = -1;
    let reachableDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < scanCount; i += 1) {
      const pos = plan.queue[i];
      const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
      if (!isMineableBlock(block, botItem)) continue;
      if (isTemporarilyBlockedTarget(botItem, block.position)) continue;
      const distance = bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5));
      if (distance <= maxDigReach && distance < reachableDistance) {
        reachableIndex = i;
        reachableDistance = distance;
      }
    }

    if (reachableIndex >= 0) {
      const [reachable] = plan.queue.splice(reachableIndex, 1);
      return new Vec3(reachable.x, reachable.y, reachable.z);
    }

    while (plan.queue.length > 0) {
      const pos = plan.queue.shift();
      const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
      if (!isMineableBlock(block, botItem)) continue;
      if (isTemporarilyBlockedTarget(botItem, block.position)) continue;
      return block.position;
    }

    botItem.miner.layerPlan = null;
    return null;
  };

  const existing = takeFromPlan();
  if (existing) return existing;

  const buildPlanForColumns = (y, layerCandidates) => {
    const minX = Math.min(...layerCandidates.map((p) => p.x));
    const maxX = Math.max(...layerCandidates.map((p) => p.x));
    const minZ = Math.min(...layerCandidates.map((p) => p.z));
    const maxZ = Math.max(...layerCandidates.map((p) => p.z));

    const corner = Math.floor(Math.random() * 4);
    const cornerX = corner === 0 || corner === 2 ? minX : maxX;
    const cornerZ = corner === 0 || corner === 1 ? minZ : maxZ;

    const ordered = layerCandidates
      .slice()
      .sort((a, b) => {
        const da = Math.abs(a.x - cornerX) + Math.abs(a.z - cornerZ);
        const db = Math.abs(b.x - cornerX) + Math.abs(b.z - cornerZ);
        if (da !== db) return da - db;
        if (a.z !== b.z) return a.z - b.z;
        return a.x - b.x;
      });

    botItem.miner.layerPlan = {
      y,
      corner,
      queue: ordered.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    };
  };

  const buildPlanForLayer = (y) => {
    const corner = Math.floor(Math.random() * 4);
    const xForward = corner === 0 || corner === 2;
    const zForward = corner === 0 || corner === 1;
    const zList = range(area.z1, area.z2, zForward);
    const queue = [];

    for (let zi = 0; zi < zList.length; zi += 1) {
      const z = zList[zi];
      const rowXForward = zi % 2 === 0 ? xForward : !xForward;
      const xList = range(area.x1, area.x2, rowXForward);
      for (const x of xList) {
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!isMineableBlock(block, botItem)) continue;
        if (isTemporarilyBlockedTarget(botItem, block.position)) continue;
        queue.push({ x, y, z });
      }
    }

    if (queue.length === 0) return false;
    botItem.miner.layerPlan = { y, corner, queue };
    return true;
  };

  if (columns.length > 0) {
    for (let y = area.yMax; y >= area.yMin; y -= 1) {
      const layerCandidates = [];
      for (const col of columns) {
        const block = bot.blockAt(new Vec3(col.x, y, col.z));
        if (!isMineableBlock(block, botItem)) continue;
        if (isTemporarilyBlockedTarget(botItem, block.position)) continue;
        layerCandidates.push(block.position);
      }
      if (layerCandidates.length === 0) continue;
      buildPlanForColumns(y, layerCandidates);
      return takeFromPlan();
    }
    return null;
  }

  for (let y = area.yMax; y >= area.yMin; y -= 1) {
    if (!buildPlanForLayer(y)) continue;
    return takeFromPlan();
  }

  botItem.miner.layerPlan = null;
  return null;
}
async function mineOneBlock(botItem, position) {
  const bot = botItem.bot;
  if (!bot) return;

  let d = bot.entity.position.distanceTo(new Vec3(position.x + 0.5, position.y + 0.5, position.z + 0.5));
  if (!Number.isFinite(d) || d > 4.6) {
    await moveNear(bot, position.x, position.y, position.z, 3, 3000);
    d = bot.entity.position.distanceTo(new Vec3(position.x + 0.5, position.y + 0.5, position.z + 0.5));
  }

  if (!Number.isFinite(d) || d > 4.5) throw new Error('target unreachable');

  const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
  if (!isMineableBlock(block, botItem)) return;

  const hasSafePickaxe = await equipBestPickaxe(botItem);
  if (!hasSafePickaxe) throw new Error('Brak bezpiecznego kilofa (niska trwalosc lub brak kilofa)');

  botItem.miner.lastAction = `digging ${block.name} @ ${position.x},${position.y},${position.z}`;
  botItem.status = `miner: kopie ${block.name}`;
  emitBots();

  const digPromise = bot.dig(block, true);
  const started = await waitForDigStart(bot, position, 4000);
  if (!started) {
    try {
      if (typeof bot.stopDigging === 'function') bot.stopDigging();
    } catch (_) {
      // ignore
    }
    throw new Error('dig start timeout');
  }

  await digPromise;
  botItem.miner.minedBlocks += 1;
}

function buildMiniMap(bot, radius = 4) {
  if (!bot?.entity?.position) return '';
  const center = bot.entity.position.floored();
  const rows = [];

  const charFrom = (name) => {
    if (!name) return '?';
    if (name.includes('water')) return '~';
    if (name.includes('lava')) return '!';
    if (name.includes('chest') || name.includes('barrel')) return 'C';
    if (name.includes('grass')) return 'g';
    if (name.includes('dirt')) return 'd';
    if (name.includes('stone') || name.includes('deepslate')) return 's';
    if (name.includes('sand')) return '.';
    if (name.includes('log') || name.includes('wood')) return 'w';
    if (name.includes('leaves')) return '*';
    return '#';
  };

  for (let z = -radius; z <= radius; z += 1) {
    let row = '';
    for (let x = -radius; x <= radius; x += 1) {
      if (x === 0 && z === 0) {
        row += 'B';
        continue;
      }
      const b = bot.blockAt(new Vec3(center.x + x, center.y - 1, center.z + z));
      if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') row += ' ';
      else row += charFrom(b.name);
    }
    rows.push(row);
  }
  return rows.join('\n');
}

function updatePreview(botItem) {
  const bot = botItem.bot;
  if (!bot || !botItem.connected) {
    botItem.preview = { map: '', updatedAt: null };
    return;
  }
  botItem.preview = {
    map: buildMiniMap(bot, 4),
    updatedAt: new Date().toISOString(),
  };
}

async function runMinerLoop(botItem) {
  const bot = botItem.bot;
  if (!bot) return;

  if (!botItem.miner.config.area) {
    botItem.status = 'miner: brak ustawionego obszaru';
    botItem.miner.running = false;
    emitBots();
    return;
  }

  if (!(botItem.miner.blockedTargets instanceof Map)) botItem.miner.blockedTargets = new Map();
  botItem.miner.lastTargetKey = null;
  botItem.miner.sameTargetStreak = 0;
  botItem.miner.layerPlan = null;
  botItem.miner.autoChestPos = null;

  botItem.miner.running = true;
  botItem.miner.stopRequested = false;
  botItem.miner.lastAction = 'started';
  botItem.status = 'miner: start';
  configureMinerMovements(botItem, true);
  emitBots();

  while (botItem.bot && botItem.connected && !botItem.miner.stopRequested) {
    try {
      if (shouldDepositItems(botItem)) {
        const forceAutoChest = botItem.miner.config.placeChestsInCorner === true;
        if (forceAutoChest) {
          const placed = await tryPlaceAutoChest(botItem);
          if (!placed) {
            botItem.status = 'miner: EQ pelny, brak skrzynek';
            botItem.miner.lastAction = 'inventory full no chest';
            notifyBotOnChat(botItem, '[BOT] Koniec skrzynek lub brak miejsca na skrzynke.');
            emitBots();
            break;
          }
        } else if (!botItem.miner.config.chest) {
          const placed = await tryPlaceAutoChest(botItem);
          if (!placed) {
            botItem.status = 'miner: EQ pelny, brak skrzynek';
            botItem.miner.lastAction = 'inventory full no chest';
            notifyBotOnChat(botItem, '[BOT] Koniec skrzynek lub brak miejsca na skrzynke.');
            emitBots();
            break;
          }
        }
        await depositItemsToChest(botItem);
      }

      const target = findNextMineTarget(botItem);
      if (!target) {
        botItem.status = 'miner: obszar wykopany';
        botItem.miner.lastAction = 'finished';
        break;
      }

      const targetKey = `${target.x},${target.y},${target.z}`;
      if (botItem.miner.lastTargetKey === targetKey) botItem.miner.sameTargetStreak += 1;
      else {
        botItem.miner.lastTargetKey = targetKey;
        botItem.miner.sameTargetStreak = 1;
      }

      if (botItem.miner.sameTargetStreak >= 3) {
        blockMinerTarget(botItem, target, 240000);
        botItem.status = `miner: omijam zapetlony blok @ ${target.x},${target.y},${target.z}`;
        botItem.miner.lastAction = 'skip looped target';
        emitBots();
        await sleep(120);
        continue;
      }

      try {
        await mineOneBlock(botItem, target);
        await collectNearbyDrops(botItem, 7);
        botItem.miner.sameTargetStreak = 0;
      } catch (err) {
        blockMinerTarget(botItem, target, 180000);
        botItem.status = `miner: pomijam trudny blok @ ${target.x},${target.y},${target.z}`;
        botItem.miner.lastAction = 'skip blocked target';
        emitBots();
        await sleep(120);
        continue;
      }

      updatePreview(botItem);
      emitBots();
      await sleep(60);
    } catch (err) {
      botItem.status = `miner error: ${err.message}`;
      botItem.miner.lastAction = 'error';
      emitBots();
      await sleep(350);
    }
  }

  configureMinerMovements(botItem, false);
  botItem.miner.running = false;
  botItem.miner.stopRequested = false;
  if (!botItem.status.startsWith('miner: obszar wykopany') && !botItem.status.startsWith('miner error:')) {
    botItem.status = botItem.connected ? 'online' : 'offline';
  }
  emitBots();
}


const FARM_CROP_RULES = {
  wheat: { seed: 'wheat_seeds', matureAge: 7 },
  potatoes: { seed: 'potato', matureAge: 7 },
  carrots: { seed: 'carrot', matureAge: 7 },
  beetroots: { seed: 'beetroot_seeds', matureAge: 3 },
};

function cropAge(block) {
  if (!block) return null;

  if (typeof block.getProperties === 'function') {
    const props = block.getProperties();
    if (props && props.age !== undefined) {
      const ageNum = Number(props.age);
      if (Number.isFinite(ageNum)) return ageNum;
    }
  }

  if (typeof block.metadata === 'number' && Number.isFinite(block.metadata)) {
    return block.metadata;
  }

  return null;
}

function hasSeed(bot, seedName) {
  if (!bot || !bot.inventory || typeof bot.inventory.items !== 'function') return null;
  return bot.inventory.items().find((it) => it.name === seedName) || null;
}

function findMatureCrop(botItem) {
  const bot = botItem.bot;
  const area = botItem.farmer.config.area;
  if (!bot || !area) return null;

  for (let y = area.yMax; y >= area.yMin; y -= 1) {
    for (let x = area.x1; x <= area.x2; x += 1) {
      for (let z = area.z1; z <= area.z2; z += 1) {
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!block || !FARM_CROP_RULES[block.name]) continue;
        if (hasLavaAround(bot, block.position)) continue;
        const rule = FARM_CROP_RULES[block.name];
        const age = cropAge(block);
        if (age != null && age >= rule.matureAge) return { block, rule };
      }
    }
  }

  return null;
}

function findPlantSpot(botItem) {
  const bot = botItem.bot;
  const area = botItem.farmer.config.area;
  if (!bot || !area) return null;

  const seeds = ['wheat_seeds', 'potato', 'carrot', 'beetroot_seeds'];
  let chosenSeed = null;
  for (const seed of seeds) {
    if (hasSeed(bot, seed)) {
      chosenSeed = seed;
      break;
    }
  }
  if (!chosenSeed) return null;

  for (let x = area.x1; x <= area.x2; x += 1) {
    for (let z = area.z1; z <= area.z2; z += 1) {
      for (let y = area.yMax; y >= area.yMin; y -= 1) {
        const at = bot.blockAt(new Vec3(x, y, z));
        const below = bot.blockAt(new Vec3(x, y - 1, z));

        if (at && at.name === 'farmland') {
          const above = bot.blockAt(new Vec3(x, y + 1, z));
          if (above && (above.name === 'air' || above.name === 'cave_air' || above.name === 'void_air')) {
            return { soil: at, seed: chosenSeed };
          }
        }

        if (at && (at.name === 'air' || at.name === 'cave_air' || at.name === 'void_air')) {
          if (below && below.name === 'farmland') {
            return { soil: below, seed: chosenSeed };
          }
        }
      }
    }
  }

  return null;
}

async function plantOnFarmland(botItem, soilBlock, seedName) {
  const bot = botItem.bot;
  if (!bot) return false;
  const item = hasSeed(bot, seedName);
  if (!item) return false;

  await moveNear(bot, soilBlock.position.x, soilBlock.position.y + 1, soilBlock.position.z, 3);
  await bot.equip(item, 'hand');
  await bot.placeBlock(soilBlock, new Vec3(0, 1, 0));
  botItem.farmer.planted += 1;
  botItem.farmer.lastAction = `planted ${seedName}`;
  return true;
}

function configureMinerMovements(botItem, enabled) {
  const bot = botItem.bot;
  if (!bot || !bot.pathfinder) return;

  if (enabled) {
    if (!botItem.miner.prevMovements) {
      botItem.miner.prevMovements = bot.pathfinder.movements || null;
    }

    try {
      const mcData = require('minecraft-data')(bot.version);
      const mv = new Movements(bot, mcData);
      mv.allowParkour = false;
      mv.allowSprinting = false;
      mv.allow1by1towers = false;
      mv.canDig = false;
      mv.maxDropDown = 0;

      const avoid = ['lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire'];
      for (const name of avoid) {
        const b = mcData.blocksByName?.[name];
        if (b && Number.isFinite(b.id)) mv.blocksToAvoid.add(b.id);
      }

      bot.pathfinder.setMovements(mv);
    } catch (_) {
      // Ignore movements setup errors.
    }

    bot.setControlState('jump', false);
    return;
  }

  try {
    if (botItem.miner.prevMovements) {
      bot.pathfinder.setMovements(botItem.miner.prevMovements);
    }
  } catch (_) {
    // Ignore restore errors.
  }

  botItem.miner.prevMovements = null;
  bot.setControlState('jump', false);
}
function configureFarmerMovements(botItem, enabled) {
  const bot = botItem.bot;
  if (!bot || !bot.pathfinder) return;

  if (enabled) {
    if (!botItem.farmer.prevMovements) {
      botItem.farmer.prevMovements = bot.pathfinder.movements || null;
    }

    try {
      const mcData = require('minecraft-data')(bot.version);
      const mv = new Movements(bot, mcData);
      mv.allowParkour = false;
      mv.allowSprinting = false;
      mv.allow1by1towers = false;
      mv.canDig = false;

      const avoid = ['lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire'];
      for (const name of avoid) {
        const b = mcData.blocksByName?.[name];
        if (b && Number.isFinite(b.id)) mv.blocksToAvoid.add(b.id);
      }

      bot.pathfinder.setMovements(mv);
    } catch (_) {
      // Ignore movements setup errors.
    }

    bot.setControlState('jump', false);
    return;
  }

  try {
    if (botItem.farmer.prevMovements) {
      bot.pathfinder.setMovements(botItem.farmer.prevMovements);
    }
  } catch (_) {
    // Ignore restore errors.
  }

  botItem.farmer.prevMovements = null;
  bot.setControlState('jump', false);
}

async function runFarmerLoop(botItem) {
  const bot = botItem.bot;
  if (!bot) return;
  if (!botItem.farmer.config.area) {
    botItem.status = 'farmer: brak ustawionego obszaru';
    configureFarmerMovements(botItem, false);
    botItem.farmer.running = false;
    emitBots();
    return;
  }

  botItem.farmer.running = true;
  botItem.farmer.stopRequested = false;
  botItem.farmer.lastAction = 'started';
  botItem.status = 'farmer: start';
  configureFarmerMovements(botItem, true);
  emitBots();

  while (botItem.bot && botItem.connected && !botItem.farmer.stopRequested) {
    try {
      bot.setControlState('jump', false);
      let worked = false;

      // Priority: first fill all empty farmland, then harvest.
      const spot = findPlantSpot(botItem);
      if (spot) {
        try {
          await plantOnFarmland(botItem, spot.soil, spot.seed);
          worked = true;
        } catch (_) {
          // no-op
        }
      } else {
        const mature = findMatureCrop(botItem);
        if (mature) {
          const crop = mature.block;
          await moveNear(bot, crop.position.x, crop.position.y, crop.position.z, 3);
          const current = bot.blockAt(crop.position);
          if (current && FARM_CROP_RULES[current.name] && !hasLavaAround(bot, current.position)) {
            const rule = FARM_CROP_RULES[current.name];
            await bot.dig(current, true);
            botItem.farmer.harvested += 1;
            botItem.farmer.lastAction = `harvest ${current.name}`;
            worked = true;
            await sleep(80);
            const soil = bot.blockAt(new Vec3(crop.position.x, crop.position.y - 1, crop.position.z));
            if (soil && soil.name === 'farmland') {
              try {
                await plantOnFarmland(botItem, soil, rule.seed);
              } catch (_) {
                // no-op
              }
            }
          }
        }
      }
      if (shouldDepositItems(botItem)) {
        if (!botItem.farmer.config.chest) {
          const placed = await tryPlaceAutoChest(botItem, 'farmer');
          if (!placed) {
            botItem.status = 'farmer: EQ pelny, brak skrzynek';
            botItem.farmer.lastAction = 'inventory full no chest';
            notifyBotOnChat(botItem, '[BOT] Farmer: brak skrzynek, daj mi chesty.');
            emitBots();
            break;
          }
        }
        await depositItemsToChest(botItem, 'farmer');
      }

      emitBots();
      await sleep(worked ? 80 : 350);
    } catch (err) {
      botItem.status = `farmer error: ${err.message}`;
      botItem.farmer.lastAction = 'error';
      emitBots();
      await sleep(350);
    }
  }

  configureFarmerMovements(botItem, false);
    botItem.farmer.running = false;
  botItem.farmer.stopRequested = false;
  if (!botItem.status.startsWith('farmer error:')) {
    botItem.status = botItem.connected ? 'online' : 'offline';
  }
  emitBots();
}

function getTopBlockInColumn(bot, x, z, yMin, yMax, surfaceMode) {
  let fromY = yMax;
  let toY = yMin;
  if (surfaceMode) {
    fromY = 320;
    toY = -64;
  }

  for (let y = fromY; y >= toY; y -= 1) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) continue;
    if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue;
    return block;
  }
  return null;
}

function buildTopdownMap(bot, area, yMin, yMax, surfaceMode) {
  const cells = [];
  for (let z = area.z1; z <= area.z2; z += 1) {
    for (let x = area.x1; x <= area.x2; x += 1) {
      const block = getTopBlockInColumn(bot, x, z, yMin, yMax, surfaceMode);
      cells.push({
        x,
        z,
        topY: block ? block.position.y : null,
        blockName: block ? block.name : 'air',
      });
    }
  }

  return {
    area,
    yMin,
    yMax,
    surfaceMode,
    width: area.x2 - area.x1 + 1,
    height: area.z2 - area.z1 + 1,
    center: {
      x: Math.floor(bot.entity.position.x),
      z: Math.floor(bot.entity.position.z),
    },
    cells,
  };
}

function bindBotEvents(botItem, bot) {
  bot.once('spawn', () => {
    botItem.connected = true;
    botItem.status = 'online';
    botItem.coords = bot.entity?.position
      ? {
          x: Number(bot.entity.position.x.toFixed(2)),
          y: Number(bot.entity.position.y.toFixed(2)),
          z: Number(bot.entity.position.z.toFixed(2)),
        }
      : null;

    try {
      const mcData = require('minecraft-data')(bot.version);
      const mv = new Movements(bot, mcData);
      const avoid = ['lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire'];
      for (const name of avoid) {
        const b = mcData.blocksByName?.[name];
        if (b && Number.isFinite(b.id)) mv.blocksToAvoid.add(b.id);
      }
      bot.pathfinder.setMovements(mv);
    } catch (err) {
      botItem.status = `pathfinder error: ${err.message}`;
    }

    updatePreview(botItem);
    emitBots();
  });

  bot.on('move', () => {
    if (!bot.entity?.position) return;
    botItem.coords = {
      x: Number(bot.entity.position.x.toFixed(2)),
      y: Number(bot.entity.position.y.toFixed(2)),
      z: Number(bot.entity.position.z.toFixed(2)),
    };
    updatePreview(botItem);
    emitBots();
  });

  bot.on('kicked', (reason) => {
    botItem.status = `kicked: ${String(reason)}`;
    emitBots();
  });

  bot.on('error', (err) => {
    botItem.status = `error: ${err.message}`;
    emitBots();
  });

  bot.on('end', () => {
    botItem.connected = false;
    botItem.bot = null;
    botItem.miner.running = false;
    botItem.miner.stopRequested = true;
    botItem.miner.prevMovements = null;
    configureFarmerMovements(botItem, false);
    botItem.farmer.running = false;
    botItem.farmer.stopRequested = true;
    botItem.preview = { map: '', updatedAt: null };
    if (!botItem.status.startsWith('error:') && !botItem.status.startsWith('kicked:')) {
      botItem.status = 'offline';
    }
    emitBots();
  });
}

function connectBot(botItem) {
  if (botItem.bot) return { ok: false, message: 'Bot juz jest podlaczony lub laczy.' };

  botItem.status = 'connecting...';
  emitBots();

  try {
    const bot = mineflayer.createBot({
      host: botItem.host,
      port: botItem.port,
      username: botItem.username,
      version: botItem.version,
      auth: botItem.auth,
      hideErrors: true,
    });

    bot.loadPlugin(pathfinder);
    botItem.bot = bot;
    bindBotEvents(botItem, bot);
    return { ok: true };
  } catch (err) {
    botItem.status = `error: ${err.message}`;
    botItem.bot = null;
    emitBots();
    return { ok: false, message: err.message };
  }
}

function disconnectBot(botItem) {
  stopMiner(botItem, true);
  stopFarmer(botItem, true);

  if (!botItem.bot) {
    botItem.connected = false;
    botItem.status = 'offline';
    botItem.coords = null;
    botItem.preview = { map: '', updatedAt: null };
    emitBots();
    return { ok: false, message: 'Bot nie jest podlaczony.' };
  }

  const active = botItem.bot;
  botItem.status = 'disconnecting...';
  emitBots();

  try {
    active.quit('Rozlaczono z panelu');
  } catch (_) {
    active.end();
  }

  botItem.connected = false;
  botItem.bot = null;
  botItem.status = 'offline';
  botItem.coords = null;
  botItem.preview = { map: '', updatedAt: null };
  emitBots();
  return { ok: true };
}

app.get('/api/bots', (_req, res) => {
  res.json(Array.from(bots.values()).map(safeBotView));
});

app.post('/api/bots', (req, res) => {
  const { name, username, host, port, version, auth } = req.body || {};
  if (!username || !host) return res.status(400).json({ error: 'username i host sa wymagane.' });

  const botItem = createBotItem({ name, username, host, port, version, auth });
  bots.set(botItem.id, botItem);
  saveBotsToFile();
  emitBots();
  return res.status(201).json(safeBotView(botItem));
});

app.put('/api/bots/:id', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });

  const { name, username, host, port, version, auth } = req.body || {};
  if (name !== undefined) botItem.name = String(name);

  const reconnectNeeded =
    (username !== undefined && String(username) !== botItem.username) ||
    (host !== undefined && String(host) !== botItem.host) ||
    (port !== undefined && Number(port) !== botItem.port) ||
    (version !== undefined && String(version) !== botItem.version) ||
    (auth !== undefined && (auth === 'microsoft' ? 'microsoft' : 'offline') !== botItem.auth);

  if (reconnectNeeded && botItem.bot) disconnectBot(botItem);

  if (username !== undefined) botItem.username = String(username);
  if (host !== undefined) botItem.host = String(host);
  if (port !== undefined) botItem.port = Number(port);
  if (version !== undefined) botItem.version = String(version);
  if (auth !== undefined) botItem.auth = auth === 'microsoft' ? 'microsoft' : 'offline';

  saveBotsToFile();
  emitBots();
  return res.json(safeBotView(botItem));
});

app.delete('/api/bots/:id', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });

  disconnectBot(botItem);
  bots.delete(botItem.id);
  saveBotsToFile();
  emitBots();
  return res.status(204).send();
});

app.post('/api/bots/:id/connect', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  const result = connectBot(botItem);
  if (!result.ok) return res.status(400).json({ error: result.message });
  return res.json({ ok: true });
});

app.post('/api/bots/:id/disconnect', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  disconnectBot(botItem);
  return res.json({ ok: true });
});

app.post('/api/bots/connect-all', (_req, res) => {
  const results = [];
  for (const botItem of bots.values()) {
    const result = connectBot(botItem);
    results.push({ id: botItem.id, ok: result.ok, message: result.message || null });
  }
  return res.json({ ok: true, results });
});

app.post('/api/bots/disconnect-all', (_req, res) => {
  for (const botItem of bots.values()) disconnectBot(botItem);
  return res.json({ ok: true });
});

app.post('/api/bots/:id/miner/configs', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  const body = req.body || {};
  const base = body.config && typeof body.config === 'object' ? body.config : botItem.miner.config;
  const config = normalizeMinerConfig(base || {});
  if (!config.area) return res.status(400).json({ error: 'Brak poprawnego configu minera do zapisu.' });
  const name = normalizeProfileName(body.name, `Miner ${botItem.minerProfiles.length + 1}`);
  const entry = { id: createId(), name, config };
  botItem.minerProfiles.push(entry);
  saveBotsToFile();
  emitBots();
  return res.json({ ok: true, config: entry });
});
app.delete('/api/bots/:id/miner/configs/:configId', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  const before = botItem.minerProfiles.length;
  botItem.minerProfiles = botItem.minerProfiles.filter((p) => p.id !== req.params.configId);
  if (botItem.minerProfiles.length === before) return res.status(404).json({ error: 'Config minera nie istnieje.' });
  saveBotsToFile();
  emitBots();
  return res.json({ ok: true });
});
app.post('/api/bots/:id/miner/start-config/:configId', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  if (!botItem.bot || !botItem.connected) return res.status(400).json({ error: 'Bot musi byc online.' });
  if (botItem.miner.running) return res.status(400).json({ error: 'Miner juz dziala.' });
  if (botItem.farmer.running) return res.status(400).json({ error: 'Najpierw zatrzymaj farmera.' });
  const profile = botItem.minerProfiles.find((p) => p.id === req.params.configId);
  if (!profile) return res.status(404).json({ error: 'Config minera nie istnieje.' });
  const config = normalizeMinerConfig(profile.config || {});
  if (!config.area) return res.status(400).json({ error: 'Ten config minera jest niepoprawny.' });
  botItem.miner.config = config;
  botItem.miner.minedBlocks = 0;
  botItem.miner.stopRequested = false;
  saveBotsToFile();
  emitBots();
  runMinerLoop(botItem).catch((err) => {
    botItem.miner.running = false;
    botItem.status = `miner fatal: ${err.message}`;
    emitBots();
  });
  return res.json({ ok: true, name: profile.name });
});
app.post('/api/bots/:id/farmer/configs', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  const body = req.body || {};
  const base = body.config && typeof body.config === 'object' ? body.config : botItem.farmer.config;
  const config = normalizeFarmerConfig(base || {});
  if (!config.area) return res.status(400).json({ error: 'Brak poprawnego configu farmera do zapisu.' });
  const name = normalizeProfileName(body.name, `Farmer ${botItem.farmerProfiles.length + 1}`);
  const entry = { id: createId(), name, config };
  botItem.farmerProfiles.push(entry);
  saveBotsToFile();
  emitBots();
  return res.json({ ok: true, config: entry });
});
app.delete('/api/bots/:id/farmer/configs/:configId', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  const before = botItem.farmerProfiles.length;
  botItem.farmerProfiles = botItem.farmerProfiles.filter((p) => p.id !== req.params.configId);
  if (botItem.farmerProfiles.length === before) return res.status(404).json({ error: 'Config farmera nie istnieje.' });
  saveBotsToFile();
  emitBots();
  return res.json({ ok: true });
});
app.post('/api/bots/:id/farmer/start-config/:configId', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  if (!botItem.bot || !botItem.connected) return res.status(400).json({ error: 'Bot musi byc online.' });
  if (botItem.farmer.running) return res.status(400).json({ error: 'Farmer juz dziala.' });
  if (botItem.miner.running) return res.status(400).json({ error: 'Najpierw zatrzymaj minera.' });
  const profile = botItem.farmerProfiles.find((p) => p.id === req.params.configId);
  if (!profile) return res.status(404).json({ error: 'Config farmera nie istnieje.' });
  const config = normalizeFarmerConfig(profile.config || {});
  if (!config.area) return res.status(400).json({ error: 'Ten config farmera jest niepoprawny.' });
  botItem.farmer.config = config;
  botItem.farmer.harvested = 0;
  botItem.farmer.planted = 0;
  botItem.farmer.stopRequested = false;
  saveBotsToFile();
  emitBots();
  runFarmerLoop(botItem).catch((err) => {
    configureFarmerMovements(botItem, false);
    botItem.farmer.running = false;
    botItem.status = `farmer fatal: ${err.message}`;
    emitBots();
  });
  return res.json({ ok: true, name: profile.name });
});

app.post('/api/bots/:id/miner/start', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  if (!botItem.bot || !botItem.connected) return res.status(400).json({ error: 'Bot musi byc online.' });
  if (botItem.miner.running) return res.status(400).json({ error: 'Miner juz dziala.' });
  if (botItem.farmer.running) return res.status(400).json({ error: 'Najpierw zatrzymaj farmera.' });

  const config = normalizeMinerConfig(req.body || {});
  if (!config.area) return res.status(400).json({ error: 'Podaj poprawny obszar kopania.' });

  botItem.miner.config = config;
  botItem.miner.minedBlocks = 0;
  botItem.miner.stopRequested = false;
  saveBotsToFile();
  emitBots();

  runMinerLoop(botItem).catch((err) => {
    botItem.miner.running = false;
    botItem.status = `miner fatal: ${err.message}`;
    emitBots();
  });

  return res.json({ ok: true });
});

app.post('/api/bots/:id/miner/start-current-chunk', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  if (!botItem.bot || !botItem.connected) return res.status(400).json({ error: 'Bot musi byc online.' });
  if (botItem.miner.running) return res.status(400).json({ error: 'Miner juz dziala.' });
  if (botItem.farmer.running) return res.status(400).json({ error: 'Najpierw zatrzymaj farmera.' });

  const body = req.body || {};
  const yMinRaw = Number(body.yMin);
  const yMaxRaw = Number(body.yMax);
  const minToolDurabilityRaw = Number(body.minToolDurability);
  const chunkRadiusRaw = Number(body.chunkRadius);

  const yMin = Number.isFinite(yMinRaw) ? Math.floor(yMinRaw) : -60;
  const yMax = Number.isFinite(yMaxRaw) ? Math.floor(yMaxRaw) : Math.floor(botItem.bot.entity.position.y);
  const minToolDurability = Number.isFinite(minToolDurabilityRaw) ? Math.max(1, Math.floor(minToolDurabilityRaw)) : 20;
  const chunkRadius = Number.isFinite(chunkRadiusRaw) ? Math.max(0, Math.floor(chunkRadiusRaw)) : 0;
  const placeChestsInCorner = body.placeChestsInCorner === true;

  let chest = null;
  if (body.chest && typeof body.chest === 'object') {
    const x = Math.floor(Number(body.chest.x));
    const y = Math.floor(Number(body.chest.y));
    const z = Math.floor(Number(body.chest.z));
    if ([x, y, z].every(Number.isFinite)) chest = { x, y, z };
  }

  const area = areaFromCurrentChunk(botItem.bot.entity.position, yMin, yMax, chunkRadius);
  botItem.miner.config = { area, columns: [], chest, minToolDurability, placeChestsInCorner };
  botItem.miner.minedBlocks = 0;
  botItem.miner.stopRequested = false;
  saveBotsToFile();
  emitBots();

  runMinerLoop(botItem).catch((err) => {
    botItem.miner.running = false;
    botItem.status = `miner fatal: ${err.message}`;
    emitBots();
  });

  return res.json({ ok: true, area });
});

app.get('/api/bots/:id/miner/topdown-map', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  if (!botItem.bot || !botItem.connected) return res.status(400).json({ error: 'Bot musi byc online.' });

  const chunkRadiusRaw = Number(req.query.chunkRadius);
  const yMinRaw = Number(req.query.yMin);
  const yMaxRaw = Number(req.query.yMax);
  const surfaceMode = String(req.query.surface ?? '1') !== '0';

  const chunkRadius = Number.isFinite(chunkRadiusRaw) ? Math.max(0, Math.min(4, Math.floor(chunkRadiusRaw))) : 0;
  const yMin = Number.isFinite(yMinRaw) ? Math.floor(yMinRaw) : -64;
  const yMax = Number.isFinite(yMaxRaw) ? Math.floor(yMaxRaw) : 320;

  const area = areaFromCurrentChunk(botItem.bot.entity.position, yMin, yMax, chunkRadius);
  const map = buildTopdownMap(botItem.bot, area, Math.min(yMin, yMax), Math.max(yMin, yMax), surfaceMode);

  return res.json({ ok: true, map });
});

app.post('/api/bots/:id/miner/start-selected', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  if (!botItem.bot || !botItem.connected) return res.status(400).json({ error: 'Bot musi byc online.' });
  if (botItem.miner.running) return res.status(400).json({ error: 'Miner juz dziala.' });
  if (botItem.farmer.running) return res.status(400).json({ error: 'Najpierw zatrzymaj farmera.' });

  const body = req.body || {};
  const yMinRaw = Number(body.yMin);
  const yMaxRaw = Number(body.yMax);
  const minToolDurabilityRaw = Number(body.minToolDurability);

  const yMin = Number.isFinite(yMinRaw) ? Math.floor(yMinRaw) : -60;
  const yMax = Number.isFinite(yMaxRaw) ? Math.floor(yMaxRaw) : Math.floor(botItem.bot.entity.position.y);
  const minToolDurability = Number.isFinite(minToolDurabilityRaw) ? Math.max(1, Math.floor(minToolDurabilityRaw)) : 20;
  const placeChestsInCorner = body.placeChestsInCorner === true;

  const columns = columnsFromSelection(body.columns);
  if (columns.length === 0) return res.status(400).json({ error: 'Brak zaznaczonych pol do kopania.' });

  let chest = null;
  if (body.chest && typeof body.chest === 'object') {
    const x = Math.floor(Number(body.chest.x));
    const y = Math.floor(Number(body.chest.y));
    const z = Math.floor(Number(body.chest.z));
    if ([x, y, z].every(Number.isFinite)) chest = { x, y, z };
  }

  const area = areaFromColumns(columns, yMin, yMax);
  botItem.miner.config = { area, columns, chest, minToolDurability, placeChestsInCorner };
  botItem.miner.minedBlocks = 0;
  botItem.miner.stopRequested = false;
  saveBotsToFile();
  emitBots();

  runMinerLoop(botItem).catch((err) => {
    botItem.miner.running = false;
    botItem.status = `miner fatal: ${err.message}`;
    emitBots();
  });

  return res.json({ ok: true, area, selectedColumns: columns.length });
});

app.post('/api/bots/:id/miner/stop', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  stopMiner(botItem);
  return res.json({ ok: true });
});

app.post('/api/bots/:id/farmer/start', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  if (!botItem.bot || !botItem.connected) return res.status(400).json({ error: 'Bot musi byc online.' });
  if (botItem.farmer.running) return res.status(400).json({ error: 'Farmer juz dziala.' });
  if (botItem.miner.running) return res.status(400).json({ error: 'Najpierw zatrzymaj minera.' });
  const config = normalizeFarmerConfig(req.body || {});
  if (!config.area) return res.status(400).json({ error: 'Podaj poprawny obszar farmy.' });
  botItem.farmer.config = config;
  botItem.farmer.harvested = 0;
  botItem.farmer.planted = 0;
  botItem.farmer.stopRequested = false;
  saveBotsToFile();
  emitBots();
  runFarmerLoop(botItem).catch((err) => {
    configureFarmerMovements(botItem, false);
    botItem.farmer.running = false;
    botItem.status = `farmer fatal: ${err.message}`;
    emitBots();
  });
  return res.json({ ok: true });
});
app.post('/api/bots/:id/farmer/stop', (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  stopFarmer(botItem);
  return res.json({ ok: true });
});
app.post('/api/bots/:id/farmer/deposit-all', async (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  if (!botItem.bot || !botItem.connected) return res.status(400).json({ error: 'Bot musi byc online.' });
  try {
    if (!botItem.farmer.config.chest) {
      const placed = await tryPlaceAutoChest(botItem, 'farmer');
      if (!placed) {
        notifyBotOnChat(botItem, '[BOT] Farmer: brak skrzynki i nie moge postawic nowej.');
        return res.status(400).json({ error: 'Brak skrzynki i nie udalo sie postawic auto skrzynki.' });
      }
    }
    await depositItemsToChest(botItem, 'farmer');
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: `Nie udalo sie odlozyc itemow: ${err.message}` });
  }
});

app.post('/api/bots/:id/deposit-all', async (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  if (!botItem.bot || !botItem.connected) return res.status(400).json({ error: 'Bot musi byc online.' });

  try {
    const forceAutoChest = botItem.miner.config.placeChestsInCorner === true;
    if (forceAutoChest) {
      const placed = await tryPlaceAutoChest(botItem);
      if (!placed) {
        notifyBotOnChat(botItem, '[BOT] Brak skrzynki i nie moge postawic nowej.');
        return res.status(400).json({ error: 'Brak skrzynki i nie udalo sie postawic auto skrzynki.' });
      }
    } else if (!botItem.miner.config.chest) {
      const placed = await tryPlaceAutoChest(botItem);
      if (!placed) {
        notifyBotOnChat(botItem, '[BOT] Brak skrzynki i nie moge postawic nowej.');
        return res.status(400).json({ error: 'Brak skrzynki i nie udalo sie postawic auto skrzynki.' });
      }
    }

    await depositItemsToChest(botItem);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: `Nie udalo sie odlozyc itemow: ${err.message}` });
  }
});

app.post('/api/bots/:id/control', async (req, res) => {
  const botItem = bots.get(req.params.id);
  if (!botItem) return res.status(404).json({ error: 'Bot nie istnieje.' });
  if (!botItem.bot || !botItem.connected) return res.status(400).json({ error: 'Bot musi byc online.' });

  const bot = botItem.bot;
  const { action } = req.body || {};
  const durationMs = clamp(Number(req.body?.durationMs) || 250, 80, 2000);
  const stepDeg = clamp(Number(req.body?.stepDeg) || 15, 1, 90);
  const stepRad = (stepDeg * Math.PI) / 180;
  const moveActions = new Set(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']);

  if (moveActions.has(action)) {
    bot.setControlState(action, true);
    setTimeout(() => bot.setControlState(action, false), durationMs);
    return res.json({ ok: true });
  }

  if (action === 'stop') {
    for (const key of moveActions) bot.setControlState(key, false);
    return res.json({ ok: true });
  }

  if (action === 'turnLeft') {
    await bot.look(bot.entity.yaw + stepRad, bot.entity.pitch, true);
    return res.json({ ok: true });
  }
  if (action === 'turnRight') {
    await bot.look(bot.entity.yaw - stepRad, bot.entity.pitch, true);
    return res.json({ ok: true });
  }
  if (action === 'lookUp') {
    await bot.look(bot.entity.yaw, clamp(bot.entity.pitch - stepRad, -1.55, 1.55), true);
    return res.json({ ok: true });
  }
  if (action === 'lookDown') {
    await bot.look(bot.entity.yaw, clamp(bot.entity.pitch + stepRad, -1.55, 1.55), true);
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Nieznana akcja sterowania.' });
});

io.on('connection', (socket) => {
  socket.emit('bots:update', Array.from(bots.values()).map(safeBotView));
});

loadBotsFromFile();

setInterval(() => {
  for (const botItem of bots.values()) {
    if (!botItem.bot || !botItem.connected) continue;
    updatePreview(botItem);
  }
  emitBots();
}, 1000);

server.listen(PORT, () => {
  console.log(`Panel botow dziala na porcie ${PORT}`);
});





































