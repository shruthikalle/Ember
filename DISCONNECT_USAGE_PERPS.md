# Disconnect Usage in Perps Trading

## Summary
The perps trading interface (`PerpsChatInterface.tsx`) does **NOT** call the backend `/disconnect/:sessionId` endpoint. It manages wallet state locally and only listens to MetaMask disconnect events.

## Disconnect-Related Code Locations

### 1. PerpsChatInterface.tsx (Main Perps Component)
**Location**: `src/components/PerpsChatInterface.tsx:420-469`

**Function**: `handleDisconnect`
- **Purpose**: Listens to MetaMask `disconnect` events
- **Behavior**: 
  - **Guarded**: Never clears wallet state during execution (chain switches trigger false disconnect events)
  - **Guarded**: Never clears if `walletAddressRef.current` is locked (prevents clearing during signing)
  - **Verification**: Double-checks MetaMask is actually disconnected before clearing state
  - **Does NOT call backend**: Only manages local React state

**Key Guards**:
```typescript
if (isExecutingRef.current) {
  // Ignore disconnect during execution (chain switches)
  return;
}
if (walletAddressRef.current) {
  // Ignore disconnect if wallet is locked (during signing)
  return;
}
```

### 2. useWallet.ts Hook
**Location**: `src/hooks/useWallet.ts:183-203`

**Function**: `disconnectWallet`
- **Purpose**: Disconnects wallet from backend session
- **Calls**: `DELETE /disconnect/:sessionId` endpoint
- **Usage**: Used by other components (WalletConnect, MetaMaskButton) but **NOT** by PerpsChatInterface

### 3. Backend Disconnect Endpoint
**Location**: `backend/src/server.ts:175-196`

**Endpoint**: `DELETE /disconnect/:sessionId`
- **Purpose**: Removes wallet session from backend
- **Note**: PerpsChatInterface does not use backend sessions, so this endpoint is not called for perps trading

### 4. WalletConnect Component
**Location**: `src/components/WalletConnect.tsx:16-18`

**Function**: `handleDisconnect`
- **Calls**: `disconnectWallet()` from `useWallet` hook
- **Note**: This component is separate from PerpsChatInterface

## Key Finding
**PerpsChatInterface manages its own wallet state independently** and does not integrate with the backend session system. It only:
1. Listens to MetaMask events
2. Manages local React state
3. Guards against false disconnect events during chain switches

The backend `/disconnect/:sessionId` endpoint is only used by components that use the `useWallet` hook (like WalletConnect), not by the perps trading interface.
