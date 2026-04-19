# Swap Execution Flow

This document describes the complete flow for executing Uniswap swaps in the application.

## Overview

The swap execution follows this path:
1. **User confirms trade** → `handleConfirmTrade()` in `ChatInterface.tsx`
2. **Build transaction** → `/api/buildSwap` → `buildSwapTransaction()` in `uniswap.ts`
3. **Execute transaction** → MetaMask transaction signing
4. **Wait for confirmation** → Poll for transaction receipt

---

## 1. User Confirms Trade

**Location:** `src/components/ChatInterface.tsx` - `handleConfirmTrade()`

```typescript
const handleConfirmTrade = async () => {
  // 1. Build swap transaction via API
  const buildResponse = await fetch('/api/buildSwap', {
    method: 'POST',
    body: JSON.stringify({
      intent: reviewModal.intent,  // TradeIntent with amountUsd/amountToken
      quote: reviewModal.quote,     // Quote from Uniswap API
      walletAddress,
    }),
  });
  
  const txRequest = await buildResponse.json(); // BuildSwapTx
  // Contains: { to, data, value, chainId, gas, deadline }
}
```

**Key Points:**
- Uses `quote.amountIn` from the quote (this is the raw amount in wei/smallest unit)
- The quote was built using `intent.amountUsd` or `intent.amountToken`
- Transaction parameters are returned: `to`, `data`, `value`, `chainId`, `gas`, `deadline`

---

## 2. Build Swap Transaction

**Location:** `src/lib/uniswap.ts` - `buildSwapTransaction()`

### Step 2.1: Validate Tokens
```typescript
const tokenIn = getToken(normalizeTokenSymbol(intent.tokenInSymbol));
const tokenOut = getToken(normalizeTokenSymbol(intent.tokenOutSymbol));
```

### Step 2.2: Check Token Approval
```typescript
const amountInBigInt = BigInt(quote.amountIn); // From quote result
const checks = await checkTokenApproval(
  provider,
  tokenIn.address,
  walletAddress,
  UNISWAP_ROUTER_ADDRESS,
  amountInBigInt,
  tokenIn.symbol
);

// Throws error if approval needed (except for native ETH)
if (!checks.hasApproval && tokenIn.symbol !== 'ETH') {
  throw new Error(`Missing token approval...`);
}
```

**Important:** Uses `quote.amountIn` (raw amount from quote), not recalculating from intent.

### Step 2.3: Build Swap Parameters
```typescript
const params = {
  tokenIn: tokenInAddressForRouter,  // WETH address if native ETH
  tokenOut: tokenOutAddressForRouter, // WETH address if native ETH
  fee: 500,                           // 0.05% fee tier
  recipient: walletAddress,
  deadline: calculateDeadline(),      // 10 minutes from now
  amountIn: quote.amountIn,          // ⚠️ Uses quote.amountIn directly
  amountOutMinimum: quote.minAmountOut,
  sqrtPriceLimitX96: 0,
};
```

**Key Point:** `amountIn` comes from `quote.amountIn`, which was calculated in `getQuoteFromAPI()`.

### Step 2.4: Encode Transaction
```typescript
const data = router.interface.encodeFunctionData('exactInputSingle', [params]);
```

### Step 2.5: Set Transaction Value
```typescript
// For native ETH swaps, include ETH value in transaction
const txValue = tokenIn.symbol === 'ETH' && tokenIn.address === '0x0000000000000000000000000000000000000000'
  ? `0x${BigInt(quote.amountIn).toString(16)}` // Include ETH amount
  : '0x0'; // No native value for ERC20 swaps
```

**Returns:** `BuildSwapTx` object with `{ to, data, value, chainId, gas, deadline }`

---

## 3. Execute Transaction

**Location:** `src/components/ChatInterface.tsx` - `handleConfirmTrade()`

### MetaMask Transaction

```typescript
// Pre-flight gas estimation
const estimatedGas = await provider.estimateGas({
  to: txRequest.to,
  data: txRequest.data,
  value: txRequest.value,
  from: walletAddress,
});

// Send transaction via MetaMask
const tx = await signer.sendTransaction({
  to: txRequest.to,
  data: txRequest.data,
  value: txRequest.value,
  gasLimit: txRequest.gas ? BigInt(txRequest.gas) : undefined,
});

// Returns: TransactionResponse with tx.hash
```

**Key Points:**
- Uses `txRequest.value` which contains the ETH amount for native ETH swaps
- Uses `txRequest.data` which contains the encoded swap function call
- MetaMask handles signing and broadcasting

---

## 4. Wait for Confirmation

```typescript
// Wait for receipt
const receipt = await tx.wait(1); // Wait for 1 confirmation

if (receipt) {
  const receiptSummary: ReceiptSummary = {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber || 0,
    gasUsed: receipt.gasUsed.toString(),
    status: receipt.status === 1 ? 'success' : 'failed',
    explorerUrl: `https://basescan.org/tx/${receipt.hash}`,
    fromToken: reviewModal.intent.tokenInSymbol,
    toToken: reviewModal.intent.tokenOutSymbol,
    amountIn: reviewModal.quote.amountInFormatted,  // Formatted display amount
    amountOut: reviewModal.quote.amountOutFormatted, // Formatted display amount
  };
}
```

---

## Critical Flow: Amount Calculation

### When User Says "Buy $1 ETH"

1. **Intent Parsing** (`src/lib/llm.ts`):
   ```typescript
   {
     side: 'BUY',
     amountUsd: 1,              // ✅ $1 USD
     tokenInSymbol: 'USDC',     // Spending USDC
     tokenOutSymbol: 'ETH',     // Buying ETH
   }
   ```

2. **Quote Calculation** (`src/lib/uniswap.ts` - `getQuoteFromAPI()`):
   ```typescript
   if (intent.amountUsd) {
     if (tokenIn.symbol === 'USDC') {
       // USDC: 1 USD = 1 USDC (with 6 decimals)
       const usdAmount = intent.amountUsd.toFixed(6); // "1.000000"
       requiredAmount = ethers.parseUnits(usdAmount, tokenIn.decimals); // 1000000 (6 decimals)
       amountInRaw = requiredAmount.toString(); // "1000000"
     }
   }
   
   // Send to Uniswap API
   url.searchParams.set('amount', amountInRaw); // "1000000" = 1 USDC
   
   // Quote result
   const result = {
     amountIn: finalAmountIn, // "1000000" (1 USDC in raw units)
     amountInFormatted: ethers.formatUnits(finalAmountIn, tokenIn.decimals), // "1.0"
   };
   ```

3. **Transaction Building** (`src/lib/uniswap.ts` - `buildSwapTransaction()`):
   ```typescript
   const amountInBigInt = BigInt(quote.amountIn); // BigInt("1000000")
   
   const params = {
     amountIn: quote.amountIn, // "1000000" = 1 USDC
     // ...
   };
   ```

4. **Transaction Execution**:
   ```typescript
   const tx = await signer.sendTransaction({
     to: txRequest.to,           // Uniswap Router
     data: txRequest.data,       // Encoded exactInputSingle with amountIn = 1000000
     value: txRequest.value,     // "0x0" (no native ETH, using USDC)
   });
   ```

**Result:** Transaction spends 1 USDC (not 1 ETH) to buy ETH worth ~$1.

---

## Potential Issues

### Issue: Amount Mismatch

If the transaction is trying to buy 1 ETH instead of $1 worth of ETH, check:

1. **Quote Calculation:**
   - Verify `intent.amountUsd` is set (not `amountToken`)
   - Verify `tokenIn.symbol === 'USDC'` when `amountUsd` is set
   - Check logs: `[Uniswap] Amount calculation (USD -> USDC)`

2. **Quote Result:**
   - Verify `quote.amountIn` is "1000000" (1 USDC) not "1000000000000000000" (1 ETH)
   - Check logs: `[Uniswap] Amount In (formatted): 1.0 USDC`

3. **Transaction Building:**
   - Verify `amountInBigInt` uses `quote.amountIn` directly
   - Check logs: `[Uniswap BuildSwap] amountIn: 1000000`

4. **Transaction Execution:**
   - Verify `txRequest.value` is "0x0" for USDC swaps
   - Verify `txRequest.data` contains the correct `amountIn` parameter

---

## Logging Points

To debug amount issues, check these logs:

1. **Intent Parsing:**
   - `[LLM Parser]` or `[Fallback Parser]` - Shows parsed intent

2. **Quote Calculation:**
   - `[Uniswap] Amount calculation (USD -> USDC)` - Shows USD to USDC conversion
   - `[Uniswap] Amount In (formatted): X USDC` - Shows formatted input amount
   - `[Uniswap] Amount Out (formatted): Y ETH` - Shows formatted output amount

3. **Transaction Building:**
   - `[Uniswap BuildSwap] amountIn: X` - Shows raw amount being used
   - `[Uniswap BuildSwap] Swap parameters` - Shows all swap parameters

4. **Transaction Execution:**
   - `[ChatInterface] Gas estimate: X` - Shows gas estimation
   - `[ChatInterface] Transaction submitted! Hash: X` - Shows transaction hash

---

## Summary

The swap execution uses `quote.amountIn` throughout the flow:
- **Quote calculation** converts `intent.amountUsd` → raw amount → Uniswap API
- **Quote result** contains `amountIn` in raw units
- **Transaction building** uses `quote.amountIn` directly
- **Transaction execution** encodes `quote.amountIn` in the function call

**If the transaction is buying 1 ETH instead of $1 worth of ETH, the issue is likely in the quote calculation step, not the execution step.**
