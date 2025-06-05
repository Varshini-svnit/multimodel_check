/**
 * Enhanced context provider with:
 * - Session persistence
 * - Reconnection state management
 * - Conversation history caching
 */

import { createContext, FC, ReactNode, useContext, useEffect, useState, useCallback } from "react";
import { useLiveAPI, UseLiveAPIResults } from "../hooks/use-live-api";
import { LiveClientOptions, Content } from "../types/types";

interface EnhancedLiveAPIResults extends UseLiveAPIResults {
  isReconnecting: boolean;
  conversationHistory: Content[];
  addToHistory: (content: Content) => void;
  clearHistory: () => void;
}

const LiveAPIContext = createContext<EnhancedLiveAPIResults | undefined>(undefined);

export type LiveAPIProviderProps = {
  children: ReactNode;
  options: LiveClientOptions;
};

export const LiveAPIProvider: FC<LiveAPIProviderProps> = ({
  options,
  children,
}) => {
  const liveAPI = useLiveAPI(options);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<Content[]>([]);

  // Load saved history on mount
  useEffect(() => {
    try {
      const savedHistory = localStorage.getItem('gemini_conversation_history');
      if (savedHistory) {
        setConversationHistory(JSON.parse(savedHistory));
      }
    } catch (error) {
      console.error('Failed to load conversation history', error);
    }
  }, []);

  // Handle reconnection states - using supported events
  useEffect(() => {
    const handleOpen = () => setIsReconnecting(false);
    const handleClose = () => setIsReconnecting(true);

    liveAPI.client.on('open', handleOpen);
    liveAPI.client.on('close', handleClose);

    return () => {
      liveAPI.client.off('open', handleOpen);
      liveAPI.client.off('close', handleClose);
    };
  }, [liveAPI.client]);

  // Persist history changes with useCallback for stability
  const addToHistory = useCallback((content: Content) => {
    setConversationHistory(prev => {
      const updated = [...prev, content];
      try {
        localStorage.setItem('gemini_conversation_history', JSON.stringify(updated));
      } catch (error) {
        console.error('Failed to save conversation history', error);
      }
      return updated;
    });
  }, []);

  // Add clear history functionality
  const clearHistory = useCallback(() => {
    setConversationHistory([]);
    try {
      localStorage.removeItem('gemini_conversation_history');
    } catch (error) {
      console.error('Failed to clear conversation history', error);
    }
  }, []);

  const value = {
    ...liveAPI,
    isReconnecting,
    conversationHistory,
    addToHistory,
    clearHistory
  };

  return (
    <LiveAPIContext.Provider value={value}>
      {children}
    </LiveAPIContext.Provider>
  );
};

export const useLiveAPIContext = () => {
  const context = useContext(LiveAPIContext);
  if (!context) {
    throw new Error("useLiveAPIContext must be used within a LiveAPIProvider");
  }
  return context;
};