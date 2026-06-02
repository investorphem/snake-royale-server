require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "http://localhost:3000", methods: ["GET", "POST"] }
});

// --- WEB3 SETTLEMENT SETUP ---
// Connect to Celo Alfajores Testnet
const provider = new ethers.JsonRpcProvider("https://alfajores-forno.celo-testnet.org");
const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);

const CONTRACT_ADDRESS = "YOUR_WAGER_CONTRACT_ADDRESS"; // Paste your contract address here
const CONTRACT_ABI = [
  "function declareWinner(uint256 _roomId, address _winner) external"
];
const wagerContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

// --- GAME STATE ---
const GRID_SIZE = 20;
const SCORE_TO_WIN = 10; // First to 10 length wins
const CURRENT_ROOM_ID = 1; // Hardcoded to room 1 for the MVP

const gameState = {
  players: {},
  food: { x: 0, y: 0 },
  gameActive: true
};

function generateFoodLocation() {
  gameState.food.x = Math.floor(Math.random() * (800 / GRID_SIZE - 2) + 1) * GRID_SIZE;
  gameState.food.y = Math.floor(Math.random() * (600 / GRID_SIZE - 2) + 1) * GRID_SIZE;
}
generateFoodLocation();

io.on('connection', (socket) => {
  // Wait for the client to send their wallet address before spawning them
  socket.on('joinArena', (walletAddress) => {
    if (!gameState.gameActive) return;

    gameState.players[socket.id] = {
      id: socket.id,
      wallet: walletAddress, // Store their Web3 wallet address
      x: 400,
      y: 300,
      body: [{ x: 400, y: 300 }, { x: 380, y: 300 }, { x: 360, y: 300 }],
      color: Math.random() > 0.5 ? 0x00ff00 : 0x00ffff
    };

    socket.emit('currentPlayers', gameState.players);
    socket.emit('foodLocation', gameState.food);
    socket.broadcast.emit('newPlayer', gameState.players[socket.id]);
  });

  socket.on('playerMovement', async (movementData) => {
    const player = gameState.players[socket.id];
    if (player && gameState.gameActive) {
      player.x = movementData.x;
      player.y = movementData.y;
      player.body = movementData.body;

      // FOOD COLLISION & WIN LOGIC
      if (player.x === gameState.food.x && player.y === gameState.food.y) {
        const tail = player.body[player.body.length - 1] || { x: player.x, y: player.y };
        player.body.push({ x: tail.x, y: tail.y });
        
        generateFoodLocation();
        io.emit('foodLocation', gameState.food);
        io.emit('playerScoreUpdate', { id: player.id, body: player.body });

        // CHECK WIN CONDITION
        if (player.body.length >= SCORE_TO_WIN) {
          gameState.gameActive = false;
          io.emit('gameOver', { winnerWallet: player.wallet });
          
          console.log(`🚨 WINNER DETECTED: ${player.wallet}. Initiating Smart Contract Settlement...`);
          
          try {
            // Securely call the blockchain to release funds
            const tx = await wagerContract.declareWinner(CURRENT_ROOM_ID, player.wallet);
            console.log(`✅ Transaction submitted! Hash: ${tx.hash}`);
            await tx.wait(); // Wait for confirmation
            console.log(`💰 Funds successfully released to ${player.wallet}`);
          } catch (error) {
            console.error("❌ Settlement failed:", error);
          }
        }
      }

      socket.broadcast.emit('playerMoved', player);
    }
  });

  socket.on('disconnect', () => {
    delete gameState.players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

const PORT = 3001;
server.listen(PORT, () => console.log(`Arena Server running on port ${PORT}`));