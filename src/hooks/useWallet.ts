import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';

export interface WalletState {
  address: string | null;
  isConnected: boolean;
  chainId: number | null;
  sessionId: string | null;
  isLoading: boolean;
  error: string | null;
}

export const useWallet = () => {
  const [state, setState] = useState<WalletState>({
    address: null,
    isConnected: false,
    chainId: null,
    sessionId: null,
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    const checkConnection = async () => {
      try {
        if (typeof window !== 'undefined' && typeof (window as any).ethereum !== 'undefined') {
          const provider = new ethers.BrowserProvider((window as any).ethereum);
          const accounts = await provider.listAccounts();
          if (accounts.length > 0) {
            const signer = await provider.getSigner();
            const address = await signer.getAddress();
            const network = await provider.getNetwork();
            setState({
              address,
              isConnected: true,
              chainId: Number(network.chainId),
              sessionId: null,
              isLoading: false,
              error: null,
            });
          }
        }
      } catch (error) {
        console.error('Error checking wallet connection:', error);
      }
    };
    checkConnection();
  }, []);

  const connectWallet = useCallback(async () => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    try {
      if (typeof window === 'undefined' || typeof (window as any).ethereum === 'undefined') {
        throw new Error('MetaMask or another Web3 wallet is required. Please install MetaMask.');
      }
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      await provider.send('eth_requestAccounts', []);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      const network = await provider.getNetwork();
      setState({
        address,
        isConnected: true,
        chainId: Number(network.chainId),
        sessionId: null,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect wallet';
      setState(prev => ({ ...prev, isLoading: false, error: errorMessage }));
      throw error;
    }
  }, []);

  const disconnectWallet = useCallback(async () => {
    setState({
      address: null,
      isConnected: false,
      chainId: null,
      sessionId: null,
      isLoading: false,
      error: null,
    });
  }, []);

  const getSessionId = useCallback(() => state.sessionId, [state.sessionId]);

  return { ...state, connectWallet, disconnectWallet, getSessionId };
};
