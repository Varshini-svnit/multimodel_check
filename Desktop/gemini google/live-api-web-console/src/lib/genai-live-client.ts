/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  Content,
  GoogleGenAI,
  LiveCallbacks,
  LiveClientToolResponse,
  LiveConnectConfig,
  LiveServerContent,
  LiveServerMessage,
  LiveServerToolCall,
  LiveServerToolCallCancellation,
  Part,
  Session,
} from "@google/genai";

import { EventEmitter } from "eventemitter3";
import { difference } from "lodash";
import { LiveClientOptions, StreamingLog } from "../types/types";
import { base64ToArrayBuffer } from "./utils";


/**
 * Custom type for SessionResumptionUpdate since it's not exported from @google/genai
 */
interface SessionResumptionUpdate {
  newHandle?: string;
  resumable: boolean;
}

interface GoAway {
  timeLeft: number;
  reason?: string;
}

/**
 * Event types that can be emitted by the MultimodalLiveClient.
 */
export interface LiveClientEventTypes {
  audio: (data: ArrayBuffer) => void;
  close: (event: CloseEvent) => void;
  content: (data: LiveServerContent) => void;
  error: (error: ErrorEvent) => void;
  interrupted: () => void;
  log: (log: StreamingLog) => void;
  open: () => void;
  setupcomplete: () => void;
  toolcall: (toolCall: LiveServerToolCall) => void;
  toolcallcancellation: (
    toolcallCancellation: LiveServerToolCallCancellation
  ) => void;
  turncomplete: () => void;
  sessionresumptionupdate: (update: SessionResumptionUpdate) => void;
  goaway: (goAway: GoAway) => void;
  generationcomplete: () => void;
}

export class GenAILiveClient extends EventEmitter<LiveClientEventTypes> {
  private _sessionHandle: string | null = null;
  private _sessionResumable = false;
  protected client: GoogleGenAI;
  private _reconnectAttempts = 0;
  private _reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private _keepAliveInterval: ReturnType<typeof setTimeout> | null = null;
  private _sessionStorage = new Map<string, string>();
  
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_CODES = new Set([
    1005, // No Status Received
    1006, // Abnormal Closure  
    1011, // Server Error / Deadline Expired
    1012, // Service Restart
    1013, // Try Again Later
    1014, // Bad Gateway
  ]);
  private readonly HEARTBEAT_INTERVAL = 25000; // 25s
  private readonly RECONNECT_BASE_DELAY = 1000;
  private readonly RECONNECT_MAX_DELAY = 30000;

  private _model: string | null = null;
  public get model() {
    return this._model;
  }

  protected config: LiveConnectConfig | null = null;

  public getConfig() {
    return this.config ? { ...this.config } : null;
  }

  private _status: "connected" | "disconnected" | "connecting" = "disconnected";
  public get status() {
    return this._status;
  }

  private _session: Session | null = null;
  public get session() {
    return this._session;
  }

  constructor(options: LiveClientOptions) {
    super();
    try {
      this._sessionHandle = this._getSessionHandle();
    } catch (e) {
      console.warn("Session handle initialization failed", e);
      this._sessionHandle = null;
    }
    this.client = new GoogleGenAI(options);
    this.onopen = this.onopen.bind(this);
    this.onerror = this.onerror.bind(this);
    this.onclose = this.onclose.bind(this);
    this.onmessage = this.onmessage.bind(this);
  }

  private _getSessionHandle(): string | null {
    try {
      return localStorage.getItem('gemini_session_handle') || 
             this._sessionStorage.get('gemini_session_handle') || 
             null;
    } catch (e) {
      console.warn("Storage access failed, using memory fallback");
      return this._sessionStorage.get('gemini_session_handle') || null;
    }
  }

  private _setSessionHandle(handle: string | null): void {
    this._sessionHandle = handle;
    try {
      if (handle) {
        localStorage.setItem('gemini_session_handle', handle);
        this._sessionStorage.set('gemini_session_handle', handle);
      } else {
        localStorage.removeItem('gemini_session_handle');
        this._sessionStorage.delete('gemini_session_handle');
      }
    } catch (e) {
      console.warn("Storage write failed, using memory fallback");
      if (handle) {
        this._sessionStorage.set('gemini_session_handle', handle);
      } else {
        this._sessionStorage.delete('gemini_session_handle');
      }
    }
  }

  protected log(type: string, message: StreamingLog["message"]) {
    const logEntry: StreamingLog = {
      date: new Date(),
      type,
      message,
    };
    this.emit("log", logEntry);
  }

  private _startKeepAlive() {
    this._stopKeepAlive();
    this._keepAliveInterval = setInterval(() => {
      try {
        if (this._status === "connected" && this._session) {
          this._session.sendClientContent({ turns: [], turnComplete: false });
          this.log("client.keepalive", "Sent heartbeat");
        }
      } catch (error) {
        this.log("client.keepalive.error", `Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
        this._stopKeepAlive();
      }
    }, this.HEARTBEAT_INTERVAL) as unknown as ReturnType<typeof setTimeout>;
  }

  private _stopKeepAlive() {
    if (this._keepAliveInterval) {
      clearInterval(this._keepAliveInterval);
      this._keepAliveInterval = null;
    }
  }

  async connect(model: string, config: LiveConnectConfig, isReconnect: boolean = false): Promise<boolean> {
    if (this._status === "connecting" || (this._status === "connected" && !isReconnect)) {
      this.log("client.connect.warn", `Already ${this._status}`);
      return false;
    }

    this._status = "connecting";
    this.config = { ...config };
    this._model = model;

    try {
      const enhancedConfig: LiveConnectConfig = {
        ...this.config,
        sessionResumption: this._sessionHandle ? {
          handle: this._sessionHandle,
        } : undefined,
      };

      this.log("client.connect", `Connecting to ${model} with session handle: ${this._sessionHandle || 'none'}`);
      
      this._session = await this.client.live.connect({
        model,
        config: enhancedConfig,
        callbacks: {
          onopen: this.onopen,
          onmessage: this.onmessage,
          onerror: this.onerror,
          onclose: this.onclose
        }
      });
      
      return true;
    } catch (error) {
      this._status = "disconnected";
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log("client.connect.error", `Connection failed: ${errorMessage}`);
      
      if (!isReconnect) {
        this._setSessionHandle(null);
        this._sessionResumable = false;
      }
      throw error;
    }
  }

  

  private async _reconnect() {
    if (this._status === "connected") return;
    
    this.log("client.reconnect", `Attempting reconnect (${this._reconnectAttempts + 1}/${this.MAX_RECONNECT_ATTEMPTS})`);
    
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }

    if (this._reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this._setSessionHandle(null);
      this._reconnectAttempts = 0;
      this.log("client.reconnect.failed", "Max reconnect attempts reached");
      return;
    }

    try {
      if (this._model && this.config) {
        await this.connect(this._model, this.config, true);
        this._reconnectAttempts = 0;
      }
    } catch (error) {
      this._reconnectAttempts++;
      const baseDelay = Math.min(
        this.RECONNECT_MAX_DELAY, 
        this.RECONNECT_BASE_DELAY * Math.pow(2, this._reconnectAttempts - 1)
      );
      const jitter = Math.random() * 1000;
      const delay = baseDelay + jitter;
      
      this.log("client.reconnect.next", `Next attempt in ${Math.round(delay / 1000)}s`);
      this._reconnectTimeout = setTimeout(() => {
        this._reconnect();
      }, delay) as unknown as ReturnType<typeof setTimeout>;
    }
  }

  public disconnect() {
    this.log("client.disconnect", "Disconnect called");
    this._stopKeepAlive();
    
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }

    if (this._session) {
      try {
        this._session.close();
        this.log("client.disconnect", "Session closed");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.log("client.disconnect.error", `Error during session close: ${errorMessage}`);
      } finally {
        this._session = null;
      }
    }
    
    if (this._status !== "disconnected") {
      this._status = "disconnected";
      this.emit("close", new CloseEvent("programmatic_disconnect", { 
        code: 1000, 
        reason: "Client initiated disconnect" 
      }));
    }
    return true;
  }

  protected onopen() {
    this._status = "connected";
    this._reconnectAttempts = 0;
    this._startKeepAlive();
    this.log("client.open", "Connection opened successfully");
    this.emit("open");
  }

  protected onerror(e: ErrorEvent) {
    this.log("server.error", `WebSocket error: ${e.message}`);
    this.emit("error", e);
  }

  protected onclose(e: CloseEvent) {
    this._stopKeepAlive();
    const previousStatus = this._status;
    this._status = "disconnected";
    
    this.log("server.close", `Connection closed. Code: ${e.code}, Reason: "${e.reason || 'No reason'}", WasClean: ${e.wasClean}`);
    this.emit("close", e);

    const shouldReconnect = this._shouldReconnectOnClose(e.code, previousStatus);
    
    if (shouldReconnect && (this._sessionHandle || this.config)) {
      this.log("client.reconnect.trigger", `Attempting reconnection after closure (code: ${e.code})`);
      this._reconnect();
    } else if (e.code === 1000 || e.code === 1001) {
      this._setSessionHandle(null);
      this._sessionResumable = false;
      this.log("client.session.clear", "Session cleared after normal closure");
    }
  }

  private _shouldReconnectOnClose(code: number, previousStatus: string): boolean {
    if (previousStatus === "connecting") {
      return false;
    }
    
    if (this.RECONNECT_CODES.has(code)) {
      return true;
    }
    
    if (code === 1000 || code === 1001) {
      return false;
    }
    
    return !!(this._sessionHandle || (this.config && this._model));
  }

  protected async onmessage(message: LiveServerMessage) {
    try {
      this.log("server.message.raw", message);

      // Handle session resumption updates
      if ('sessionResumptionUpdate' in message) {
        const update = message.sessionResumptionUpdate as unknown as SessionResumptionUpdate;
        const { newHandle, resumable } = update;
        
        if (resumable && newHandle) {
          if (this._sessionHandle !== newHandle) {
            this._setSessionHandle(newHandle);
            this.log("client.sessionUpdate", `New session handle saved: ${newHandle.substring(0, 20)}... (resumable)`);
          }
          this._sessionResumable = true;
        } else {
          this._setSessionHandle(null);
          this._sessionResumable = false;
          this.log("client.sessionUpdate", "Session not resumable");
        }
        this.emit("sessionresumptionupdate", update);
      }

      // Handle GoAway messages
      if (message['goAway']) {
        const goAway = message['goAway'] as unknown as GoAway;
        this.log("server.goAway", `Connection will terminate in ${goAway.timeLeft}ms`);
        this.emit("goaway", goAway);
      }


      if (message.setupComplete) {
        this.log("server.setupComplete", message.setupComplete);
        this.emit("setupcomplete");
      }

      if (message.toolCall) {
        this.log("server.toolCall", message.toolCall);
        this.emit("toolcall", message.toolCall);
        return;
      }

      if (message.toolCallCancellation) {
        this.log("server.toolCallCancellation", message.toolCallCancellation);
        this.emit("toolcallcancellation", message.toolCallCancellation);
        return;
      }

      if (message.serverContent) {
        const { serverContent } = message;
        
        if (typeof serverContent.interrupted !== "undefined") {
          this.log("server.content.interrupted", `Interrupted: ${serverContent.interrupted}`);
          this.emit("interrupted");
        }
        
        if (typeof serverContent.turnComplete !== "undefined") {
          this.log("server.content.turnComplete", `Turn complete: ${serverContent.turnComplete}`);
          this.emit("turncomplete");
        }

        if (serverContent.generationComplete) {
          this.log("server.content.generationComplete", "Generation complete");
          this.emit("generationcomplete");
        }

        if (serverContent.modelTurn?.parts) {
          const parts: Part[] = serverContent.modelTurn.parts;
          const audioParts = parts.filter(
            (p) => p.inlineData && p.inlineData.mimeType?.startsWith("audio/")
          );
          const otherParts = difference(parts, audioParts);

          audioParts.forEach((part) => {
            if (part.inlineData?.data) {
              try {
                const data = base64ToArrayBuffer(part.inlineData.data);
                this.emit("audio", data);
                this.log("server.audio", `Received audio (${data.byteLength} bytes)`);
              } catch (e) {
                this.log("server.audio.error", `Failed to process audio: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          });

          if (otherParts.length > 0) {
            const contentToEmit: LiveServerContent = { modelTurn: { parts: otherParts } };
            this.emit("content", contentToEmit);
            this.log("server.content.modelTurn", contentToEmit);
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log("server.message.error", `Error processing message: ${errorMessage}`);
    }
  }

  sendRealtimeInput(chunks: Array<{ mimeType: string; data: string }>) {
    if (!this._session || this._status !== "connected") {
      this.log("client.sendRealtimeInput.error", `Cannot send realtime input. Status: ${this._status}`);
      return;
    }

    let hasAudio = false;
    let hasVideo = false;
    
    for (const chunk of chunks) {
      try {
        this._session.sendRealtimeInput({ media: chunk });
        if (chunk.mimeType.includes("audio")) hasAudio = true;
        if (chunk.mimeType.includes("image") || chunk.mimeType.includes("video")) hasVideo = true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.log("client.sendRealtimeInput.exception", `Error sending chunk: ${errorMessage}`);
      }
    }
    
    if (chunks.length > 0) {
      const type = hasAudio && hasVideo ? "audio + video" : hasAudio ? "audio" : hasVideo ? "video" : "data";
      this.log("client.realtimeInput.sent", `Sent ${chunks.length} ${type} chunk(s)`);
    }
  }

  sendToolResponse(toolResponse: LiveClientToolResponse) {
    if (!this._session || this._status !== "connected") {
      this.log("client.sendToolResponse.error", `Cannot send tool response. Status: ${this._status}`);
      return;
    }

    if (toolResponse.functionResponses?.length) {
      try {
        this._session.sendToolResponse({
          functionResponses: toolResponse.functionResponses,
        });
        this.log("client.toolResponse.sent", toolResponse);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.log("client.sendToolResponse.exception", `Error sending tool response: ${errorMessage}`);
      }
    } else {
      this.log("client.sendToolResponse.warn", "No function responses provided");
    }
  }

  send(parts: Part | Part[], turnComplete: boolean = true) {
    if (!this._session || this._status !== "connected") {
      this.log("client.send.error", `Cannot send content. Status: ${this._status}`);
      return;
    }
    
    const partsArray = Array.isArray(parts) ? parts : [parts];
    if (partsArray.length === 0 && !turnComplete) {
      this.log("client.send.warn", "Empty content with turnComplete=false. Nothing sent.");
      return;
    }

    try {
      this._session.sendClientContent({ turns: [{ parts: partsArray }], turnComplete });
      this.log("client.send.sent", { turns: [{ parts: partsArray }], turnComplete });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log("client.send.exception", `Error sending content: ${errorMessage}`);
    }
  }

  getSessionInfo() {
    return {
      handle: this._sessionHandle,
      resumable: this._sessionResumable,
      status: this._status,
      reconnectAttempts: this._reconnectAttempts,
    };
  }

  forceReconnect() {
    if (this._status === "connected" && this._session) {
      this.log("client.forceReconnect", "Forcing reconnection");
      this._session.close();
    }
  }

  clearSession() {
    this._setSessionHandle(null);
    this._sessionResumable = false;
    this.log("client.session.clear", "Session handle cleared manually");
  }

  public destroy() {
    this.disconnect();
    this.removeAllListeners();
    this._sessionStorage.clear();
  }
}