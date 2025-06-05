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

import {
  GoogleGenAIOptions,
  LiveClientToolResponse,
  LiveServerMessage,
  LiveServerToolCall, // <-- Add this import
  LiveServerToolCallCancellation, // <-- Add this import
  LiveServerContent, // <-- Add this import
  Part,
} from "@google/genai";

/**
 * the options to initiate the client, ensure apiKey is required
 */
export type LiveClientOptions = GoogleGenAIOptions & { apiKey: string };

/** log types */
export type StreamingLog = {
  date: Date;
  type: string;
  count?: number;
  message:
    | string
    | ClientContentLog
    | LiveServerToolCall // <-- Add this type
    | LiveServerToolCallCancellation // <-- Add this type
    | LiveServerContent // <-- Add this type
    | Omit<LiveServerMessage, "text" | "data">
    | LiveClientToolResponse
    | any; // <-- Optionally, add any as a fallback for broader logging
};

export type ClientContentLog = {
  turns: Part[];
  turnComplete: boolean;
};
import { RefObject } from 'react';

export type Content = {
  role?: 'user' | 'model' | 'system';
  parts: Array<{
    // Text content
    text?: string;
    
    // Audio content (base64 encoded)
    audio?: {
      data: string;
      mimeType: string; // e.g., 'audio/webm', 'audio/mpeg'
    };
    
    // Video content (multiple formats supported)
    video?: {
      // Option 1: Base64 encoded data
      data?: string;
      mimeType?: string; // e.g., 'video/mp4', 'video/webm'
      
      // Option 2: Reference to video element
      ref?: RefObject<HTMLVideoElement>;
      
      // Option 3: URL source
      url?: string;
      
      // Metadata
      duration?: number; // in seconds
      dimensions?: {
        width: number;
        height: number;
      };
    };
    
    // File attachments
    file?: {
      name: string;
      data: string; // base64
      mimeType: string;
    };
  }>;
  
  // Optional metadata
  timestamp?: number;
  sessionId?: string;
  isProcessing?: boolean;
};