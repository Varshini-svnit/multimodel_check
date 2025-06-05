import { RefObject } from 'react';
import { MimeType } from './mime-types'; // Optional: for strict mime type validation

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