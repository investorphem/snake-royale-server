const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/health', (req, res) => res.status(200).send('Awake!'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 3001;

// --- HARMONIZED EXPANDED ARENA DIMENSIONS ---
const MAP_WIDTH = 2000;
const MAP_HEIGHT = 2000;
const SCORE_TO_WIN = 50; // Aligned with the high-stakes layout yields

// Global Game State Matrices
const gameState = {
  players: {},
  foods: {}, 
  foodCounter: 0,
  gameActive: true,
  arenaTheme: 'classic', // Tracked dynamically per lobby instance
  arenaTimer: 0
};

// Spawn an item with variable payload weights matching layout themes
function spawnFood(x, y, isForcedType = null) {
  const id = `food_${gameState.foodCounter++}`;
  
  let type = isForcedType || 'normal';
  
  // Apply environment-specific mutation drops dynamically
  if (!isForcedType) {
    const roll = Math.random();
    if (gameState.arenaTheme === 'arena_toxic' && roll < 0.25) {
      type = 'toxic';
    } else if (roll < 0.15) {
      type = 'epic';
    }
  }

  gameState.foods[id] = { 
    id, 
    type,
    x: x !== undefined ? x : Math.floor(Math.random() * (MAP_WIDTH - 80)) + 40, 
    y: y !== undefined ? y : Math.floor(Math.random() * (MAP_HEIGHT - 80)) + 40 
  };
  return id;
}

// Initial Map Population - Spawn 40 resource targets across the massive 2000x2000 zone
for (let i = 0; i < 40; i++) spawnFood();

// ==========================================
// CENTRAL ARENA HAZARD RUNTIME CLOCK
// Loops every 100ms to calculate continuous physics vectors (Void Gravity, Magma Eruptions)
// ==========================================
setInterval(() => {
  if (!gameState.gameActive) return;
  
  gameState.arenaTimer += 100;

  // HAZARD: MAGMA ERUPTIONS (Triggers full lobby chaotic shifts every 10 seconds)
  if (gameState.arenaTheme === 'arena_magma' && gameState.arenaTimer >= 10000) {
    gameState.arenaTimer = 0;
    io.emit('arenaEvent', { type: 'ERUPTION', duration: 2000 });
  }

  let stateChanged = false;

  // HAZARD: VOID GRAVITY WELL PULL CALCULATIONS & MAGNET POWERUP ADJUSTMENTS
  for (const socketId in gameState.players) {
    const player = gameState.players[socketId];
    
    // Server-Side Magnet Draw calculations
    if (player.modifiers.magnet) {
      for (const foodId in gameState.foods) {
        const food = gameState.foods[foodId];
        if (food.type === 'toxic') continue; // Don't vacuum pull toxic entries

        const dist = Math.hypot(player.x - food.x, player.y - food.y);
        if (dist < 250) {
          // Pull target item coordinates server-side closer to head vectors
          const angle = Math.atan2(player.y - food.y, player.x - food.x);
          food.x += Math.cos(angle) * 12;
          food.y += Math.sin(angle) * 12;
          stateChanged = true;
        }
      }
    }
  }

  if (stateChanged) {
    io.emit('foodUpdate', gameState.foods);
  }
}, 100);

// ==========================================
//Multiplayer Core Network Signalling Loops
// ==========================================
io.on('connection', (socket) => {

  socket.on('joinArena', (data) => {
    // Expected structure: { walletAddress: string, arenaTheme: string }
    const themeReceived = data?.arenaTheme || 'classic';
    gameState.arenaTheme = themeReceived;

    gameState.players[socket.id] = {
      id: socket.id,
      walletAddress: data?.walletAddress || "0xGuest",
      x: Math.floor(Math.random() * (MAP_WIDTH - 200)) + 100,
      y: Math.floor(Math.random() * (MAP_HEIGHT - 200)) + 100,
      angle: 0,
      color: Math.random() * 0xffffff,
      body: [],
      modifiers: { speed: false, shield: false, magnet: false } // Synchronizes Active Inventory Item States
    };

    // Send complete current snapshots to connecting instance boundary
    socket.emit('currentPlayers', gameState.players);
    socket.emit('foodUpdate', gameState.foods);
    socket.emit('arenaThemeSync', gameState.arenaTheme);
    
    socket.broadcast.emit('newPlayer', gameState.players[socket.id]);
  });

  // Captures modifications fired directly across custom HUD overlays
  socket.on('usePowerUp', (powerUpType) => {
    const player = gameState.players[socket.id];
    if (!player) return;

    player.modifiers[powerUpType] = true;
    io.emit('playerPowerUpActivated', { id: socket.id, type: powerUpType });

    // Establish specific cleanup timeouts to reset server-side modifiers safely
    const cooldown = powerUpType === 'magnet' ? 10000 : 5000;
    setTimeout(() => {
      if (gameState.players[socket.id]) {
        gameState.players[socket.id].modifiers[powerUpType] = false;
        io.emit('playerPowerUpExpired', { id: socket.id, type: powerUpType });
      }
    }, cooldown);
  });

  socket.on('playerMovement', (movementData) => {
    const player = gameState.players[socket.id];
    if (!player || !gameState.gameActive) return;

    player.x = movementData.x;
    player.y = movementData.y;
    player.angle = movementData.angle;
    player.body = movementData.body;

    // HAZARD: CYBER MAP LEVEL WRAPAROUND BOUNDS INJECTIONS
    if (gameState.arenaTheme === 'arena_cyber') {
      if (player.x < 0) player.x = MAP_WIDTH;
      else if (player.x > MAP_WIDTH) player.x = 0;
      if (player.y < 0) player.y = MAP_HEIGHT;
      else if (player.y > MAP_HEIGHT) player.y = 0;
    }

    socket.broadcast.emit('playerMoved', player);

    // 1. MULTIPLAYER COMBAT: Evaluate target intersections against opponent segments
    if (!player.modifiers.shield) { // Skip calculations if player has an active Invincibility Shield running
      for (const enemyId in gameState.players) {
        if (enemyId === socket.id) continue;
        
        const enemy = gameState.players[enemyId];
        for (const segment of enemy.body) {
          const dist = Math.hypot(player.x - segment.x, player.y - segment.y);
          
          if (dist < 22) { 
            console.log(`💥 Player Collision Confirmed: ${socket.id} crashed into ${enemyId}!`);
            
            // Explode elements and generate food points corresponding to target body size
            player.body.forEach(seg => spawnFood(seg.x, seg.y, 'normal'));
            spawnFood(player.x, player.y, 'normal');
            
            io.emit('foodUpdate', gameState.foods);
            io.emit('playerDied', socket.id); 
            
            delete gameState.players[socket.id];
            socket.disconnect(); 
            return;
          }
        }
      }
    }

    // 2. RESOURCE CONSUMPTION LOGIC
    for (const foodId in gameState.foods) {
      const food = gameState.foods[foodId];
      const distanceToFood = Math.hypot(player.x - food.x, player.y - food.y);
      
      if (distanceToFood < 28) { 
        const eatenType = food.type;
        delete gameState.foods[foodId]; 
        
        // Compute structural variations corresponding to item type
        if (eatenType === 'toxic') {
          // Drops score metrics and shrinks body rows synchronously
          io.emit('playerHitByPoison', { id: socket.id });
          spawnFood(); // Replace resource node
        } else {
          // Standard Growth
          spawnFood(); 
          io.emit('playerScoreUpdate', { id: socket.id, body: player.body, scoreValue: eatenType === 'epic' ? 20 : 5 });
        }
        
        io.emit('foodUpdate', gameState.foods);

        // Evaluate victory thresholds
        if (player.body.length >= SCORE_TO_WIN) {
          gameState.gameActive = false;
          io.emit('gameOver', { winnerId: socket.id, winnerWallet: player.walletAddress });
        }
      }
    }
  });

  socket.on('disconnect', () => {
    delete gameState.players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

server.listen(PORT, () => console.log(`🚀 SnakeRoyale Combat Server running on Port ${PORT} with active Theme Injections`));