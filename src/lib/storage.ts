import { TradeHistoryEntry } from './types';

const STORAGE_KEY = 'uniswap_trading_history';

/**
 * Get trade history from localStorage
 */
export function getTradeHistory(): TradeHistoryEntry[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return [];
    }
    return JSON.parse(stored) as TradeHistoryEntry[];
  } catch (error) {
    console.error('Error loading trade history:', error);
    return [];
  }
}

/**
 * Save trade to history
 */
export function saveTrade(trade: TradeHistoryEntry): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const history = getTradeHistory();
    history.unshift(trade); // Add to beginning
    // Keep only last 50 trades
    const limited = history.slice(0, 50);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(limited));
  } catch (error) {
    console.error('Error saving trade:', error);
  }
}

/**
 * Update trade status
 */
export function updateTradeStatus(tradeId: string, status: TradeHistoryEntry['status'], receipt?: TradeHistoryEntry['receipt']): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const history = getTradeHistory();
    const index = history.findIndex(t => t.id === tradeId);
    if (index !== -1) {
      history[index].status = status;
      if (receipt) {
        history[index].receipt = receipt;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    }
  } catch (error) {
    console.error('Error updating trade:', error);
  }
}

/**
 * Clear trade history
 */
export function clearTradeHistory(): void {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.removeItem(STORAGE_KEY);
}
