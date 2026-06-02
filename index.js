const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors());

app.get('/health', (req, res) => res.status(200).send('Awake!'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 3001;
const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;
const SCORE_TO_WIN = 20; // Increased to 20 for a longer Royale match

// Global Game State (Upgraded to support multiple food orbs)
const gameState = {
  players: {},
  foods: {}, 
  foodCounter: 0,
  gameActive: true
};

// Spawn a single food orb
function spawnFood(x, y) {
  const id = `food_${gameState.foodCounter++}`;
  gameState.foods[id] = { 
    id, 
    x: x || Math.floor(Math.random() * (MAP_WIDTH - 40)) + 20, 
    y: y || Math.floor(Math.random() * (MAP_HEIGHT - 40)) + 20 
  };
  return id;
}

// Initial Map Population (Spawn 10 random orbs to start)
for(let i=0; i<10; i++) spawnFood();

io.on('connection', (socket) => {
  socket.on('joinArena', (walletAddress) => {
    gameState.players[socket.id] = {
      id: socket.id,
      walletAddress: walletAddress || "0xGuest",
      x: Math.floor(Math.random() * (MAP_WIDTH - 100)) + 50,
      y: Math.floor(Math.random() * (MAP_HEIGHT - 100)) + 50,
      angle: 0,
      color: Math.random() * 0xffffff,
      body: [] 
    };

    // Send current players and ALL foods to the new player
    socket.emit('currentPlayers', gameState.players);
    socket.emit('foodUpdate', gameState.foods);
    socket.broadcast.emit('newPlayer', gameState.players[socket.id]);
  });

  socket.on('playerMovement', async (movementData) => {
    const player = gameState.players[socket.id];
    if (!player || !gameState.gameActive) return;

    player.x = movementData.x;
    player.y = movementData.y;
    player.angle = movementData.angle;
    player.body = movementData.body;

    socket.broadcast.emit('playerMoved', player);

    // 1. COMBAT: Check if my head hit any enemy's body
    for (const enemyId in gameState.players) {
      if (enemyId === socket.id) continue; // Don't check against myself
      
      const enemy = gameState.players[enemyId];
      for (const segment of enemy.body) {
        const dist = Math.hypot(player.x - segment.x, player.y - segment.y);
        
        if (dist < 20) { // Collision Radius
          console.log(`💥 Player ${socket.id} crashed into ${enemyId}!`);
          
          // Drop loot! Spawn food at every segment of the dead player's body
          player.body.forEach(seg => spawnFood(seg.x, seg.y));
          spawnFood(player.x, player.y); // Drop one for the head too
          
          // Broadcast loot explosion and death
          io.emit('foodUpdate', gameState.foods);
          io.emit('playerDied', socket.id); // Tell clients to explode this snake
          
          delete gameState.players[socket.id];
          socket.disconnect(); // Boot them to menu
          return; // Stop processing movement for dead player
        }
      }
    }

    // 2. EATING: Check distance to all active foods
    for (const foodId in gameState.foods) {
      const food = gameState.foods[foodId];
      const distanceToFood = Math.hypot(player.x - food.x, player.y - food.y);
      
      if (distanceToFood < 25) { 
        delete gameState.foods[foodId]; // Remove eaten food
        spawnFood(); // Spawn a new random one to replace it
        
        io.emit('foodUpdate', gameState.foods); // Sync foods
        io.emit('playerScoreUpdate', { id: socket.id, body: player.body });

        if (player.body.length >= SCORE_TO_WIN) {
          gameState.gameActive = false;
          io.emit('gameOver', { winnerWallet: player.walletAddress });
        }
      }
    }
  });

  socket.on('disconnect', () => {
    delete gameState.players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

server.listen(PORT, () => console.log(`🚀 SnakeRoyale Combat Server running`));