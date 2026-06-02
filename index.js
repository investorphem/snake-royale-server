const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { ethers } = require('ethers');

// 1. Initial Configurations
const app = express();

// Enable CORS for frontend connection
app.use(cors());

// --- HEALTH CHECK ROUTE (For UptimeRobot) ---
// This prevents the Render free tier from putting the server to sleep
app.get('/health', (req, res) => {
  res.status(200).send('SnakeRoyale Server is awake and running!');
});
// --------------------------------------------

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Adjust this to your Vercel frontend URL in production for stricter security
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3001;
const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;
const SCORE_TO_WIN = 10; 

// 2. Global Game State
const gameState = {
  players: {},
  food: { x: 400, y: 300 },
  gameActive: true
};

// 3. Web3 Setup (Celo Sepolia)
const CELO_SEPOLIA_RPC = "https://sepolia-rpc.celo.org";
const CONTRACT_ADDRESS = "0xF30b45003dCDe160B94962bB58FA8C2E9Ab70372";

// Minimal ABI required to trigger the settlement function on your smart contract
const CONTRACT_ABI = [
  "function settleMatch(address winner) external"
];

// Helper to handle blockchain settlement
async function settleSmartContract(winnerWallet) {
  console.log(`🚨 WINNER DETECTED: Triggering contract payout for ${winnerWallet}...`);
  
  if (!process.env.ADMIN_PRIVATE_KEY) {
    console.error("❌ Settlement Failed: ADMIN_PRIVATE_KEY environment variable is not defined on Render!");
    return;
  }

  try {
    const provider = new ethers.JsonRpcProvider(CELO_SEPOLIA_RPC);
    const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

    console.log("Sending settlement transaction...");
    const tx = await contract.settleMatch(winnerWallet);
    console.log(`⏳ Transaction submitted! Hash: ${tx.hash}`);
    
    await tx.wait();
    console.log("✅ Funds successfully released to the winner on-chain!");
  } catch (error) {
    console.error("❌ Blockchain Transaction Failed:", error);
  }
}

// Helper to spawn food inside the map arena boundaries
function generateFoodLocation() {
  gameState.food.x = Math.floor(Math.random() * (MAP_WIDTH - 40)) + 20;
  gameState.food.y = Math.floor(Math.random() * (MAP_HEIGHT - 40)) + 20;
}

// Generate an initial food placement at startup
generateFoodLocation();

// 4. WebSocket Real-Time Connection Loop
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Handle a player entering the arena
  socket.on('joinArena', (walletAddress) => {
    // Assign a random spawn location and initial setup matching the 360-degree float system
    gameState.players[socket.id] = {
      id: socket.id,
      walletAddress: walletAddress || "0xGuest",
      x: Math.floor(Math.random() * (MAP_WIDTH - 100)) + 50,
      y: Math.floor(Math.random() * (MAP_HEIGHT - 100)) + 50,
      angle: 0,
      color: Math.random() * 0xffffff, // Assign a distinct random color tint to enemies
      body: [] // Array tracking float points for tail segments
    };

    // Send current map state exclusively to the newly connected player
    socket.emit('currentPlayers', gameState.players);
    socket.emit('foodLocation', gameState.food);

    // Broadcast the new player state to everyone else in the match
    socket.broadcast.emit('newPlayer', gameState.players[socket.id]);
  });

  // Process real-time player vector updates
  socket.on('playerMovement', async (movementData) => {
    const player = gameState.players[socket.id];
    
    if (player && gameState.gameActive) {
      // Update coordinates dynamically with 360-degree float data
      player.x = movementData.x;
      player.y = movementData.y;
      player.angle = movementData.angle;
      player.body = movementData.body;

      // Broadcast position changes instantly to sync other client rendering engines
      socket.broadcast.emit('playerMoved', player);

      // Perform radius-based distance tracking for food consumption
      const distanceToFood = Math.hypot(player.x - gameState.food.x, player.y - gameState.food.y);
      
      if (distanceToFood < 25) { // Collision detection radius check
        console.log(`Food consumed by: ${socket.id}`);
        
        // Relocate food state
        generateFoodLocation();
        io.emit('foodLocation', gameState.food);

        // Broadcast growth/score updates across the room
        io.emit('playerScoreUpdate', { 
          id: socket.id, 
          body: player.body 
        });

        // Evaluate match completion rules
        if (player.body.length >= SCORE_TO_WIN) {
          gameState.gameActive = false;
          
          // Broadcast freeze and game-over state to stop local inputs instantly
          io.emit('gameOver', { winnerWallet: player.walletAddress });
          
          // Trigger the contract escrow disbursement
          if (player.walletAddress !== "0xGuest") {
            await settleSmartContract(player.walletAddress);
          } else {
            console.log("Game won by Guest player. Smart contract payout skipped.");
          }
        }
      }
    }
  });

  // Handle clean disconnections
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    delete gameState.players[socket.id];
    
    // Broadcast removal event to clean up orphaned graphics from enemy dashboards
    io.emit('playerDisconnected', socket.id);
    
    // Reset match state if the lobby completely empties out
    if (Object.keys(gameState.players).length === 0) {
      gameState.gameActive = true;
      generateFoodLocation();
      console.log("Arena empty. Match state reset.");
    }
  });
});

// 5. Start Server Lifecycle
server.listen(PORT, () => {
  console.log(`🚀 SnakeRoyale Server running on port ${PORT}`);
  console.log(`Authoritative Game Settings: Target Score = ${SCORE_TO_WIN}`);
});