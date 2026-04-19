# Builder Code Verification Guide

This guide explains how to verify that ERC-8021 Builder Codes are correctly integrated and showing up on Basescan.

## ✅ Implementation Status

Builder codes are now integrated using the official `ox/erc8021` library according to [Base's documentation](https://docs.base.org/base-chain/builder-codes/app-developers).

### Integration Points

1. **`/api/buildSwap`** - Appends builder code to swap transactions
2. **`/api/execute`** - Appends builder code to swap transactions  
3. **Approval Transactions** - Builder codes also appended to token approvals

## 🔍 How to Verify Builder Codes

### Method 1: Check Server Logs

When a swap transaction is built, you should see logs like:

```
[API BuildSwap] Builder Code: bc_plqsugov
[API BuildSwap] Data ends with: 80218021802180218021802180218021
[API BuildSwap] Expected 8021 pattern: ✅ Found
```

### Method 2: Check Browser Console

Before sending a transaction, the browser console will log:

```
[ChatInterface] Builder code check: {
  dataLength: 1234,
  dataEnd: "80218021802180218021802180218021",
  hasBuilderCode: "✅ Present"
}
```

### Method 3: Verify on Basescan

1. **Find your transaction** on [Basescan](https://basescan.org)
2. **Click on the transaction** to view details
3. **Scroll to "Input Data"** section
4. **Check the last 32 characters** - should end with: `80218021802180218021802180218021`

The ERC-8021 format includes:
- Builder code (hex-encoded): `62635f706c717375676f76` (bc_plqsugov)
- Padding: `0b00`
- ERC-8021 magic bytes: `80218021802180218021802180218021` (repeating `8021`)

### Method 4: Use Builder Code Validation Tool

1. Visit: https://builder-code-checker.vercel.app/
2. Select transaction type: "Transaction"
3. Enter your transaction hash
4. Click "Check Attribution"
5. Should show: ✅ Builder code verified

### Method 5: Check base.dev Dashboard

1. Visit [base.dev](https://base.dev)
2. Go to your app settings
3. Check "Onchain" transactions
4. Transaction counts should increment when transactions with your builder code are processed

## 🐛 Troubleshooting

### Builder Code Not Showing on Basescan

**Check 1: Environment Variable**
```bash
# Verify BUILDER_CODE is set
echo $BUILDER_CODE
# Should output: bc_plqsugov (or your builder code)
```

**Check 2: Server Logs**
Look for these log messages:
- `[API BuildSwap] Builder Code: bc_plqsugov` ✅
- `[API BuildSwap] Expected 8021 pattern: ✅ Found` ✅

If you see `(none configured)`, the builder code is not set.

**Check 3: Transaction Data**
In browser console, check:
```javascript
// The transaction data should end with 8021
txRequest.data.slice(-32)
// Should end with: "80218021802180218021802180218021"
```

**Check 4: MetaMask Transaction**
When MetaMask shows the transaction, the `data` field should be very long (includes the builder code suffix).

### Common Issues

1. **Builder code not in .env**
   - Solution: Add `BUILDER_CODE=bc_plqsugov` to `.env`

2. **Double-appending**
   - The code now checks if suffix is already present to avoid double-appending

3. **Wrong format**
   - Using `ox/erc8021` ensures correct ERC-8021 format

## 📝 Technical Details

### ERC-8021 Format

The builder code suffix follows ERC-8021 specification:
```
0x[BUILDER_CODE_HEX][PADDING][8021_MAGIC_BYTES]
```

Example for `bc_plqsugov`:
```
0x62635f706c717375676f760b0080218021802180218021802180218021
```

Where:
- `62635f706c717375676f76` = "bc_plqsugov" in hex
- `0b00` = padding
- `80218021802180218021802180218021` = ERC-8021 magic bytes (repeating `8021`)

### Integration Flow

1. **Transaction Built** → `buildSwapTransaction()` creates base transaction
2. **Builder Code Appended** → `appendBuilderCodeSuffix()` adds ERC-8021 suffix
3. **Sent to MetaMask** → Transaction data includes builder code
4. **Broadcast to Base** → Transaction includes builder code in calldata
5. **Base Indexes** → Base recognizes builder code and attributes transaction

## ✅ Verification Checklist

- [ ] `BUILDER_CODE` is set in `.env`
- [ ] Server logs show builder code being appended
- [ ] Browser console shows builder code verification
- [ ] Transaction on Basescan ends with `8021` pattern
- [ ] Builder Code Validation Tool confirms attribution
- [ ] base.dev dashboard shows transaction counts

## 🔗 Resources

- [Base Builder Codes Documentation](https://docs.base.org/base-chain/builder-codes/app-developers)
- [Builder Code Validation Tool](https://builder-code-checker.vercel.app/)
- [Basescan Explorer](https://basescan.org)
- [base.dev Dashboard](https://base.dev)
