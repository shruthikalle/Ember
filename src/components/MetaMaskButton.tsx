'use client';

import { useState, useEffect } from 'react';
import { ethers } from 'ethers';

// Base Chain ID for Uniswap transactions
const BASE_CHAIN_ID = 8453;
const BASE_RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || 'https://mainnet.base.org';
const BASE_EXPLORER_URL = 'https://basescan.org';

export interface WalletState {
  address: string | null;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
}

export default function MetaMaskButton() {
  const [state, setState] = useState<WalletState>({
    address: null,
    isConnected: false,
    isLoading: false,
    error: null,
  });
  const [showAccountSelector, setShowAccountSelector] = useState(false);
  const [availableAccounts, setAvailableAccounts] = useState<string[]>([]);

  useEffect(() => {
    // Check if already connected
    const checkConnection = async () => {
      if (typeof window === 'undefined' || typeof (window as any).ethereum === 'undefined') {
        return;
      }

      try {
        const provider = new ethers.BrowserProvider((window as any).ethereum);
        const accounts = await provider.listAccounts();
        if (accounts.length > 0) {
          const signer = await provider.getSigner();
          const address = await signer.getAddress();
          const network = await provider.getNetwork();
          
          if (Number(network.chainId) === BASE_CHAIN_ID) {
            setState({
              address,
              isConnected: true,
              isLoading: false,
              error: null,
            });
          }
        }
      } catch (error) {
        console.error('Error checking connection:', error);
      }
    };

    checkConnection();

    // Listen for account changes
    if (typeof window !== 'undefined' && (window as any).ethereum) {
      (window as any).ethereum.on('accountsChanged', (accounts: string[]) => {
        if (accounts.length === 0) {
          setState({
            address: null,
            isConnected: false,
            isLoading: false,
            error: null,
          });
        } else {
          setState(prev => ({
            ...prev,
            address: accounts[0],
          }));
        }
      });

      (window as any).ethereum.on('chainChanged', (chainId: string) => {
        // Chain changes are handled by individual components (PerpsChatInterface, etc.)
        // No page reload needed - components update their state reactively
        console.log('[MetaMaskButton] Chain changed:', chainId, '- components will handle state updates');
      });
    }
  }, []);

  const fetchAccounts = async (): Promise<string[]> => {
    if (typeof window === 'undefined' || typeof (window as any).ethereum === 'undefined') {
      throw new Error('MetaMask is not installed. Please install MetaMask to use this feature.');
    }

    // Request account access first
    await (window as any).ethereum.request({ method: 'eth_requestAccounts' });
    
    // Get all accounts
    const accounts = await (window as any).ethereum.request({ method: 'eth_accounts' });
    return accounts as string[];
  };

  const connectWallet = async () => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      if (typeof window === 'undefined' || typeof (window as any).ethereum === 'undefined') {
        throw new Error('MetaMask is not installed. Please install MetaMask to use this feature.');
      }

      // Fetch all available accounts
      const accounts = await fetchAccounts();
      
      if (accounts.length === 0) {
        throw new Error('No accounts found. Please create an account in MetaMask.');
      }

      // If only one account, connect directly
      if (accounts.length === 1) {
        await connectToAccount(accounts[0]);
        return;
      }

      // Multiple accounts - show selector
      setAvailableAccounts(accounts);
      setShowAccountSelector(true);
      setState(prev => ({ ...prev, isLoading: false }));
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to connect wallet';
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: errorMessage,
      }));
    }
  };

  const connectToAccount = async (selectedAddress: string) => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    setShowAccountSelector(false);

    try {
      if (typeof window === 'undefined' || typeof (window as any).ethereum === 'undefined') {
        throw new Error('MetaMask is not installed.');
      }

      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const network = await provider.getNetwork();
      const chainId = Number(network.chainId);

      // Check if we're on Base (required for Uniswap)
      if (chainId !== BASE_CHAIN_ID) {
        try {
          // Try to switch to Base
          await (window as any).ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: `0x${BASE_CHAIN_ID.toString(16)}` }],
          });
        } catch (switchError: any) {
          // If chain doesn't exist, add it
          if (switchError.code === 4902) {
            await (window as any).ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId: `0x${BASE_CHAIN_ID.toString(16)}`,
                  chainName: 'Base',
                  nativeCurrency: {
                    name: 'ETH',
                    symbol: 'ETH',
                    decimals: 18,
                  },
                  rpcUrls: [BASE_RPC_URL],
                  blockExplorerUrls: [BASE_EXPLORER_URL],
                },
              ],
            });
          } else {
            throw new Error('Please switch to Base to continue.');
          }
        }
      }

      // Verify the selected account is actually the active one
      // MetaMask doesn't support programmatic account switching, so we need to check
      const signer = await provider.getSigner();
      const activeAddress = await signer.getAddress();
      
      if (activeAddress.toLowerCase() !== selectedAddress.toLowerCase()) {
        // Account is not active - show instructions to switch
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: `Please switch to account ${selectedAddress.slice(0, 6)}...${selectedAddress.slice(-4)} in MetaMask. The app will automatically connect when you switch.`,
        }));
        
        // Set up a listener to auto-connect when user switches
        const handleAccountSwitch = (accounts: string[]) => {
          if (accounts.length > 0 && accounts[0].toLowerCase() === selectedAddress.toLowerCase()) {
            (window as any).ethereum.removeListener('accountsChanged', handleAccountSwitch);
            setState({
              address: selectedAddress,
              isConnected: true,
              isLoading: false,
              error: null,
            });
          }
        };
        
        (window as any).ethereum.on('accountsChanged', handleAccountSwitch);
        return;
      }

      setState({
        address: selectedAddress,
        isConnected: true,
        isLoading: false,
        error: null,
      });
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to connect wallet';
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: errorMessage,
      }));
    }
  };

  const disconnectWallet = () => {
    setState({
      address: null,
      isConnected: false,
      isLoading: false,
      error: null,
    });
  };

  const handleSwitchAccount = async () => {
    try {
      const accounts = await fetchAccounts();
      if (accounts.length === 0) {
        setState(prev => ({ ...prev, error: 'No accounts found.' }));
        return;
      }
      if (accounts.length === 1) {
        // Only one account, just connect to it
        await connectToAccount(accounts[0]);
        return;
      }
      setAvailableAccounts(accounts);
      setShowAccountSelector(true);
    } catch (error: any) {
      setState(prev => ({
        ...prev,
        error: error.message || 'Failed to fetch accounts',
      }));
    }
  };

  if (state.isConnected && state.address) {
    return (
      <>
        {/* Account Selection Modal */}
        {showAccountSelector && (
          <div 
            className="fixed inset-0 bg-black/50 z-[9999]"
            style={{ 
              position: 'fixed', 
              top: 0, 
              left: 0, 
              right: 0, 
              bottom: 0
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setShowAccountSelector(false);
                setState(prev => ({ ...prev, isLoading: false }));
              }
            }}
          >
            <div 
              className="bg-trading-surface border border-trading-border rounded-lg max-w-md w-full max-h-[85vh] flex flex-col shadow-2xl"
              style={{
                position: 'relative',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                margin: 0
              }}
            >
              <div className="p-6 pb-4 flex-shrink-0">
                <h2 className="text-xl font-bold text-trading-text mb-2">Switch Account</h2>
                <p className="text-sm text-trading-text-dim">Choose which MetaMask account to connect:</p>
              </div>
              
              <div className="flex-1 overflow-y-auto px-6 pb-4">
                <div className="space-y-2">
                  {availableAccounts.map((account) => {
                    const isActive = account.toLowerCase() === state.address?.toLowerCase();
                    return (
                      <button
                        key={account}
                        onClick={() => connectToAccount(account)}
                        disabled={state.isLoading || isActive}
                        className={`w-full p-4 bg-trading-border hover:bg-trading-border/80 border rounded-lg transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed ${
                          isActive ? 'border-trading-accent border-2 bg-trading-accent/10' : 'border-trading-border'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                              isActive ? 'bg-trading-accent/30' : 'bg-trading-accent/20'
                            }`}>
                              <span className="text-trading-accent font-mono text-xs">
                                {account.slice(0, 4)}
                              </span>
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-mono text-trading-text">
                                  {account.slice(0, 6)}...{account.slice(-4)}
                                </p>
                                {isActive && (
                                  <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded">
                                    Active
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-trading-text-dim font-mono mt-0.5">
                                {account}
                              </p>
                            </div>
                          </div>
                          {state.isLoading && state.address === account && (
                            <div className="animate-spin rounded-full h-4 w-4 border-2 border-trading-accent border-t-transparent"></div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="p-6 pt-4 flex-shrink-0 border-t border-trading-border">
                <button
                  onClick={() => {
                    setShowAccountSelector(false);
                    setState(prev => ({ ...prev, isLoading: false }));
                  }}
                  disabled={state.isLoading}
                  className="w-full px-4 py-2 bg-trading-border hover:bg-trading-border/80 text-trading-text rounded-lg transition-colors text-sm disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-2 bg-trading-surface border border-trading-border rounded-lg">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
            <span className="text-sm text-trading-text font-mono">
              {`${state.address.slice(0, 6)}...${state.address.slice(-4)}`}
            </span>
          </div>
          <button
            onClick={handleSwitchAccount}
            className="px-3 py-2 bg-trading-border hover:bg-trading-border/80 text-trading-text rounded-lg transition-colors text-xs"
            title="Switch to a different account"
          >
            Switch
          </button>
          <button
            onClick={disconnectWallet}
            className="px-4 py-2 bg-trading-border hover:bg-trading-border/80 text-trading-text rounded-lg transition-colors text-sm"
          >
            Disconnect
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Account Selection Modal */}
      {showAccountSelector && (
        <div 
          className="fixed inset-0 bg-black/50 z-[9999] p-4"
          style={{ 
            position: 'fixed', 
            top: 0, 
            left: 0, 
            right: 0, 
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowAccountSelector(false);
              setState(prev => ({ ...prev, isLoading: false }));
            }
          }}
        >
          <div 
            className="bg-trading-surface border border-trading-border rounded-lg max-w-md w-full max-h-[85vh] flex flex-col shadow-2xl"
            style={{
              position: 'relative',
              margin: 'auto'
            }}
          >
            <div className="p-6 pb-4 flex-shrink-0">
              <h2 className="text-xl font-bold text-trading-text mb-2">Select Account</h2>
              <p className="text-sm text-trading-text-dim">Choose which MetaMask account to connect:</p>
            </div>
            
            <div className="flex-1 overflow-y-auto px-6 pb-4">
              <div className="space-y-2">
                {availableAccounts.map((account) => {
                  // Check current active account if connected
                  const isActive = state.isConnected && account.toLowerCase() === state.address?.toLowerCase();
                  return (
                    <button
                      key={account}
                      onClick={() => connectToAccount(account)}
                      disabled={state.isLoading}
                      className={`w-full p-4 bg-trading-border hover:bg-trading-border/80 border rounded-lg transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed ${
                        isActive ? 'border-trading-accent border-2 bg-trading-accent/10' : 'border-trading-border'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                            isActive ? 'bg-trading-accent/30' : 'bg-trading-accent/20'
                          }`}>
                            <span className="text-trading-accent font-mono text-xs">
                              {account.slice(0, 4)}
                            </span>
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-mono text-trading-text">
                                {account.slice(0, 6)}...{account.slice(-4)}
                              </p>
                              {isActive && (
                                <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded">
                                  Active
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-trading-text-dim font-mono mt-0.5">
                              {account}
                            </p>
                          </div>
                        </div>
                        {state.isLoading && state.address === account && (
                          <div className="animate-spin rounded-full h-4 w-4 border-2 border-trading-accent border-t-transparent"></div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="p-6 pt-4 flex-shrink-0 border-t border-trading-border">
              <button
                onClick={() => {
                  setShowAccountSelector(false);
                  setState(prev => ({ ...prev, isLoading: false }));
                }}
                disabled={state.isLoading}
                className="w-full px-4 py-2 bg-trading-border hover:bg-trading-border/80 text-trading-text rounded-lg transition-colors text-sm disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        {state.error && (
          <span className="text-xs text-red-400 max-w-xs truncate" title={state.error}>
            {state.error}
          </span>
        )}
        <button
          onClick={connectWallet}
          disabled={state.isLoading}
          className="px-4 py-2 bg-trading-accent hover:bg-trading-accent/80 text-black rounded-lg transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {state.isLoading ? 'Connecting...' : 'Connect MetaMask'}
        </button>
      </div>
    </>
  );
}
