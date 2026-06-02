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
  // Opening CORS to '*' ensures your Next.js frontend on Vercel can connect smoothly
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- WEB3 SETTLEMENT SETUP ---
// Updated to the official Celo Sepolia Testnet RPC Node
const provider = new ethers.JsonRpcProvider("https://forno.celo-sepolia.celo-testnet.org");

// Initialize Wallet (Render securely injects ADMIN_PRIVATE_KEY from your dashboard)
const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);

// 🚨 PASTE YOUR NEW CELO SEPOLIA CONTRACT ADDRESS HERE! 🚨
const CONTRACT_ADDRESS = "0xYourNewCeloSepoliaContractAddressHere"; 
const CONTRACT_ABI = [
  "function declareWinner(uint256 _roomId, address _winner) external"
];
const wagerContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

// --- GAME STATE ---
const GRID_SIZE = 20;
const SCORE_TO_WIN = 10; 
const CURRENT_ROOM_ID = 1; 

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
  socket.on('joinArena', (walletAddress) => {
    if (!gameState.gameActive) return;

    gameState.players[socket.id] = {
      id: socket.id,
      wallet: walletAddress, 
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

      if (player.x === gameState.food.x && player.y === gameState.food.y) {
        const tail = player.body[player.body.length - 1] || { x: player.x, y: player.y };
        player.body.push({ x: tail.x, y: tail.y });
        
        generateFoodLocation();
        io.emit('foodLocation', gameState.food);
        io.emit('playerScoreUpdate', { id: player.id, body: player.body });

        if (player.body.length >= SCORE_TO_WIN) {
          gameState.gameActive = false;
          io.emit('gameOver', { winnerWallet: player.wallet });
          
          console.log(`🚨 WINNER DETECTED: ${player.wallet}. Initiating Smart Contract Settlement...`);
          
          // The Try/Catch block prevents the server from crashing if the blockchain rejects the transaction
          try {
            const tx = await wagerContract.declareWinner(CURRENT_ROOM_ID, player.wallet);
            console.log(`✅ Transaction submitted! Hash: ${tx.hash}`);
            await tx.wait(); 
            console.log(`💰 Funds successfully released to ${player.wallet}`);
          } catch (error) {
            console.error("❌ Settlement failed on-chain. Error details:", error.message);
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
server.listen(PORT, () => console.log(`Arena Server running cleanly on port ${PORT}`));