# Amount Flow in Swap Execution

This document shows exactly where the swap amount is pulled from when making the RPC swap call.

## Complete Flow

### Step 1: Intent Parsing
**Location:** `src/lib/llm.ts` or `src/components/ChatInterface.tsx`

```typescript
// User says "Buy $1 ETH"
{
  side: 'BUY',
  amountUsd: 1,              // ← Starting point
  tokenInSymbol: 'USDC',
  tokenOutSymbol: 'ETH',
}
```

---

### Step 2: Quote Calculation
**Location:** `src/lib/uniswap.ts` - `getQuoteFromAPI()` (lines 128-182)

```typescript
// Convert intent.amountUsd to raw amount
if (intent.amountUsd) {
  if (tokenIn.symbol === 'USDC') {
    // USDC: 1 USD = 1 USDC (with 6 decimals)
    const usdAmount = intent.amountUsd.toFixed(6);        // "1.000000"
    requiredAmount = ethers.parseUnits(usdAmount, tokenIn.decimals);  // 1000000 (6 decimals)
    amountInRaw = requiredAmount.toString();              // "1000000" ← Calculated here
  }
}

// Send to Uniswap API
url.searchParams.set('amount', amountInRaw);  // "1000000"
```

**Result:** `amountInRaw = "1000000"` (1 USDC in raw units)

---

### Step 3: Store Final Amount
**Location:** `src/lib/uniswap.ts` - `getQuoteFromAPI()` (lines 304-348)

```typescript
// Store finalAmountIn (may be adjusted for USD matching)
let finalAmountIn = amountInRaw;  // "1000000"

// ... (potential adjustment logic for ETH swaps) ...

// Return in Quote result
const result = {
  amountIn: finalAmountIn,  // "1000000" ← Stored here
  // ...
};
```

**Result:** `quote.amountIn = "1000000"`

---

### Step 4: Build Swap Transaction
**Location:** `src/lib/uniswap.ts` - `buildSwapTransaction()` (line 630, 708)

```typescript
// Extract amount from quote
const amountInBigInt = BigInt(quote.amountIn);  // BigInt("1000000") ← Used for approval check

// Build swap parameters
const params = {
  tokenIn: tokenInAddressForRouter,
  tokenOut: tokenOutAddressForRouter,
  fee: 500,
  recipient: walletAddress,
  deadline,
  amountIn: quote.amountIn,  // "1000000" ← ⚠️ USED HERE IN SWAP PARAMS
  amountOutMinimum: quote.minAmountOut,
  sqrtPriceLimitX96: 0,
};
```

**Key Point:** `params.amountIn = quote.amountIn` (directly from quote, no recalculation)

---

### Step 5: Encode Transaction Data
**Location:** `src/lib/uniswap.ts` - `buildSwapTransaction()` (line 735)

```typescript
// Encode function call with params (including amountIn)
const data = router.interface.encodeFunctionData('exactInputSingle', [params]);
//                                                                    ↑
//                                    params.amountIn = "1000000" is encoded here
```

**Result:** `data` contains encoded function call with `amountIn = "1000000"`

---

### Step 6: Set Transaction Value (for native ETH only)
**Location:** `src/lib/uniswap.ts` - `buildSwapTransaction()` (lines 772-774)

```typescript
// For native ETH swaps, include ETH value in transaction
const txValue = tokenIn.symbol === 'ETH' && tokenIn.address === '0x0000000000000000000000000000000000000000'
  ? `0x${BigInt(quote.amountIn).toString(16)}`  // ← Uses quote.amountIn for ETH value
  : '0x0';  // No native value for ERC20 swaps (USDC)
```

**For USDC swaps:** `txValue = "0x0"` (no native ETH sent)
**For ETH swaps:** `txValue = quote.amountIn` converted to hex

---

### Step 7: Return Transaction Request
**Location:** `src/lib/uniswap.ts` - `buildSwapTransaction()` (lines 776-783)

```typescript
const result = {
  to: UNISWAP_ROUTER_ADDRESS,
  data,        // ← Contains encoded amountIn = "1000000"
  value: txValue,  // ← "0x0" for USDC, or ETH amount for native ETH
  chainId: getChainId(),
  gas: gasEstimate,
  deadline,
};
```

---

### Step 8: Execute Transaction (RPC Call)
**Location:** `src/components/ChatInterface.tsx` - `handleConfirmTrade()` (line 366)

```typescript
// Send transaction via MetaMask
const tx = await signer.sendTransaction({
  to: txRequest.to,           // Uniswap Router
  data: txRequest.data,       // ← Contains encoded amountIn = "1000000"
  value: txRequest.value,     // "0x0" for USDC
  gasLimit: txRequest.gas ? BigInt(txRequest.gas) : undefined,
});
```

**The RPC call uses:**
- `data`: Encoded `exactInputSingle` function call with `amountIn = "1000000"` (1 USDC)
- `value`: `"0x0"` (no native ETH for ERC20 swaps)

---

## Summary: Where the Amount Comes From

```
intent.amountUsd: 1
    ↓
getQuoteFromAPI() converts to raw: amountInRaw = "1000000"
    ↓
Stored in quote result: quote.amountIn = "1000000"
    ↓
buildSwapTransaction() uses directly: params.amountIn = quote.amountIn
    ↓
Encoded in transaction data: data = encodeFunctionData('exactInputSingle', [params])
    ↓
RPC call: signer.sendTransaction({ data, value: "0x0" })
```

## Critical Point

**The amount used in the RPC swap call comes from `quote.amountIn`, which is set in `getQuoteFromAPI()` at line 348.**

The flow is:
1. `intent.amountUsd` → converted to `amountInRaw` (line 140)
2. `amountInRaw` → stored as `finalAmountIn` (line 305)
3. `finalAmountIn` → returned as `quote.amountIn` (line 348)
4. `quote.amountIn` → used in `params.amountIn` (line 708)
5. `params.amountIn` → encoded in transaction `data` (line 735)
6. Transaction `data` → sent in RPC call (line 366)

**If the transaction is buying 1 ETH instead of $1 worth of ETH, check:**
- Line 140: Is `amountInRaw` correctly calculated as "1000000" (1 USDC)?
- Line 348: Is `quote.amountIn` set to `finalAmountIn` (not recalculated)?
- Line 708: Is `params.amountIn` using `quote.amountIn` directly?
