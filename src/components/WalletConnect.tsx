import { useWallet } from '../hooks/useWallet';
import { formatAddress } from '../utils/format';

export default function WalletConnect() {
  const { address, isConnected, isLoading, error, connectWallet, disconnectWallet } = useWallet();

  const handleConnect = async () => {
    try {
      await connectWallet();
    } catch (error) {
      // Error is already handled in the hook
      console.error('Wallet connection error:', error);
    }
  };

  const handleDisconnect = async () => {
    await disconnectWallet();
  };

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 px-3 py-2 bg-trading-surface border border-trading-border rounded-lg">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
          <span className="text-sm text-trading-text font-mono">
            {formatAddress(address)}
          </span>
        </div>
        <button
          onClick={handleDisconnect}
          className="px-4 py-2 bg-trading-border hover:bg-trading-border/80 text-trading-text rounded-lg transition-colors text-sm"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span className="text-xs text-red-400 max-w-xs text-right" title={error}>
          {error}
        </span>
      )}
      <button
        onClick={handleConnect}
        disabled={isLoading}
        className="px-4 py-2 bg-trading-accent hover:bg-trading-accent/80 text-black rounded-lg transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading ? 'Connecting...' : 'Connect Wallet'}
      </button>
    </div>
  );
}
