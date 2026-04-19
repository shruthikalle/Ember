# Quick Start Guide

## Starting the Application

This application has two parts: a **backend API server** and a **frontend React app**.

### 1. Start the Backend Server

```bash
# Navigate to backend directory
cd backend

# Install dependencies (if not already done)
npm install

# Create .env file from example
cp .env.example .env

# Edit .env and add your:
# - OPENAI_API_KEY
# - RPC_URL (Ethereum Mainnet)
# - Optionally: PRIVATE_KEY (for server-signed transactions)

# Start the backend server
npm run dev
```

The backend will run on `http://localhost:3000`

### 2. Start the Frontend

In a **new terminal window**:

```bash
# Navigate to project root
cd /Users/pratishrutkamal/Documents/ethdenver

# Install dependencies (if not already done)
npm install

# Start the frontend dev server
npm run dev
```

The frontend will run on `http://localhost:5173` (or another port if 5173 is taken)

### 3. Connect Your Wallet

1. Open the app in your browser
2. Click "Connect Wallet" in the header
3. Approve the MetaMask connection
4. Switch to Ethereum Mainnet if prompted
5. Your wallet is now connected!

## Troubleshooting

### "Cannot connect to backend server"
- Make sure the backend is running on port 3000
- Check that `npm run dev` is running in the `backend` directory
- Verify the backend started successfully (look for "Server running on http://localhost:3000")

### "MetaMask not found"
- Install MetaMask browser extension
- Refresh the page after installing

### "Wrong network"
- The app requires Ethereum Mainnet
- MetaMask will prompt to switch networks automatically
- If not, manually switch to Ethereum Mainnet in MetaMask

### Backend errors
- Check that `.env` file exists in `backend/` directory
- Verify `OPENAI_API_KEY` and `RPC_URL` are set correctly
- Check backend terminal for error messages
