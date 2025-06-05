/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GenAILiveClient } from "../lib/genai-live-client";
import { Content, LiveClientOptions } from "../types/types";
import { AudioStreamer } from "../lib/audio-streamer";
import { audioContext } from "../lib/utils";
import VolMeterWorket from "../lib/worklets/vol-meter";
import { LiveConnectConfig } from "@google/genai";

export type UseLiveAPIResults = {
  client: GenAILiveClient;
  setConfig: (config: LiveConnectConfig) => void;
  config: LiveConnectConfig;
  model: string;
  setModel: (model: string) => void;
  connected: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  volume: number;
  chatHistory: Content[];
  updateHistory: (content: Content) => void;
};

export function useLiveAPI(options: LiveClientOptions): UseLiveAPIResults {
  const client = useMemo(() => new GenAILiveClient(options), [options]);
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  const audioBufferRef = useRef<ArrayBuffer[]>([]);
  
  const [model, setModel] = useState<string>("models/gemini-2.0-flash-exp");
  const [config, setConfig] = useState<LiveConnectConfig>({});
  const [connected, setConnected] = useState(false);
  const [volume, setVolume] = useState(0);
  const [chatHistory, setChatHistory] = useState<Content[]>([]);

  // Handle session resumption on disconnect
  useEffect(() => {
    const handleDisconnect = () => {
      console.warn("🔌 Disconnected. Attempting reconnect...");
      const handle = localStorage.getItem("gemini_session_handle");
      
      if (handle) {
        client.connect(model, {
          ...config,
          sessionResumption: { handle },
        })
        .then(() => console.log("✅ Reconnected successfully"))
        .catch((err) => {
          console.error("❌ Failed to reconnect:", err instanceof Error ? err.message : err);
        });
      }
    };

    client.on("close", handleDisconnect);
    return () => {
      client.off("close", handleDisconnect);
    };
  }, [client, model, config]);

  // Load chat history from localStorage
  useEffect(() => {
    const savedHistory = localStorage.getItem('gemini_chat_history');
    if (savedHistory) {
      try {
        setChatHistory(JSON.parse(savedHistory));
      } catch (e) {
        console.error("Failed to parse chat history", e);
      }
    }
  }, []);

  const updateHistory = useCallback((newContent: Content) => {
    setChatHistory(prev => {
      const updated = [...prev, newContent];
      localStorage.setItem('gemini_chat_history', JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Initialize audio streamer
  useEffect(() => {
    if (!audioStreamerRef.current) {
      audioContext({ id: "audio-out" }).then((audioCtx: AudioContext) => {
        audioStreamerRef.current = new AudioStreamer(audioCtx);
        audioStreamerRef.current
          .addWorklet("vumeter-out", VolMeterWorket, (ev: MessageEvent) => {
            setVolume(ev.data.volume);
          })
          .catch((err) => console.error("Failed to add worklet:", err));
      }).catch((err) => console.error("Failed to initialize audio context:", err));
    }

    return () => {
      audioStreamerRef.current?.stop();
    };
  }, []);

  // Flush audio buffer when connected
  const flushAudioBuffer = useCallback(() => {
    if (audioStreamerRef.current) {
      audioBufferRef.current.forEach(buf => {
        audioStreamerRef.current?.addPCM16(new Uint8Array(buf));
      });
      audioBufferRef.current = [];
    }
  }, []);

  // Setup client event listeners
  useEffect(() => {
    const onOpen = () => {
      setConnected(true);
      flushAudioBuffer();
    };

    const onClose = () => {
      setConnected(false);
    };

    const onError = (error: Error) => {
      console.error("Client error:", error);
    };

    const stopAudioStreamer = () => {
      audioStreamerRef.current?.stop();
    };

    const onAudio = (data: ArrayBuffer) => {
      if (!connected) {
        audioBufferRef.current.push(data);
      } else {
        audioStreamerRef.current?.addPCM16(new Uint8Array(data));
      }
    };

    client
      .on("open", onOpen)
      .on("close", onClose)
      .on("interrupted", stopAudioStreamer)
      .on("audio", onAudio);

    return () => {
      client
        .off("open", onOpen)
        .off("close", onClose)
        .off("interrupted", stopAudioStreamer)
        .off("audio", onAudio);
    };
  }, [client, connected, flushAudioBuffer]);

  const connect = useCallback(async () => {
    if (!config) {
      throw new Error("Configuration has not been set");
    }
    try {
      await client.disconnect();
      await client.connect(model, config);
    } catch (err) {
      console.error("Connection error:", err);
      throw err;
    }
  }, [client, config, model]);

  const disconnect = useCallback(async () => {
    try {
      await client.disconnect();
      setConnected(false);
    } catch (err) {
      console.error("Disconnection error:", err);
      throw err;
    }
  }, [client]);

  return {
    client,
    config,
    setConfig,
    model,
    setModel,
    connected,
    connect,
    disconnect,
    volume,
    chatHistory,
    updateHistory,
  };
}