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

import cn from "classnames";

import { memo, ReactNode, RefObject, useEffect, useRef, useState } from "react";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { UseMediaStreamResult } from "../../hooks/use-media-stream-mux";
import { useScreenCapture } from "../../hooks/use-screen-capture";
import { useWebcam } from "../../hooks/use-webcam";
import { AudioRecorder } from "../../lib/audio-recorder";
import AudioPulse from "../audio-pulse/AudioPulse";
import "./control-tray.scss";
import SettingsDialog from "../settings-dialog/SettingsDialog";

export type ControlTrayProps = {
  videoRef: RefObject<HTMLVideoElement>;
  children?: ReactNode;
  supportsVideo: boolean;
  onVideoStreamChange?: (stream: MediaStream | null) => void;
  enableEditingSettings?: boolean;
};

type MediaStreamButtonProps = {
  isStreaming: boolean;
  onIcon: string;
  offIcon: string;
  start: () => Promise<any>;
  stop: () => any;
};

/**
 * button used for triggering webcam or screen-capture
 */
const MediaStreamButton = memo(
  ({ isStreaming, onIcon, offIcon, start, stop }: MediaStreamButtonProps) =>
    isStreaming ? (
      <button className="action-button" onClick={stop}>
        <span className="material-symbols-outlined">{onIcon}</span>
      </button>
    ) : (
      <button className="action-button" onClick={start}>
        <span className="material-symbols-outlined">{offIcon}</span>
      </button>
    )
);

function ControlTray({
  videoRef,
  children,
  onVideoStreamChange = () => {},
  supportsVideo,
  enableEditingSettings,
}: ControlTrayProps) {
  const videoStreams = [useWebcam(), useScreenCapture()];
  const [activeVideoStream, setActiveVideoStream] =
    useState<MediaStream | null>(null);
  const [webcam, screenCapture] = videoStreams;
  const [inVolume, setInVolume] = useState(0);
  const [audioRecorder] = useState(() => new AudioRecorder());
  const [muted, setMuted] = useState(false);
  const renderCanvasRef = useRef<HTMLCanvasElement>(null);
  const connectButtonRef = useRef<HTMLButtonElement>(null);
  const inputBufferRef = useRef<Array<{ mimeType: string; data: string }>>([]);
  const {
    client,
    connected,
    connect,
    disconnect,
    volume,
    isReconnecting,
    conversationHistory
  } = useLiveAPIContext();

  useEffect(() => {
    if (!connected && connectButtonRef.current) {
      connectButtonRef.current.focus();
    }
  }, [connected]);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--volume",
      `${Math.max(5, Math.min(inVolume * 200, 8))}px`
    );
  }, [inVolume]);

  // Handle audio stream during reconnections
  useEffect(() => {
    const onData = (base64: string) => {
      if (connected && !isReconnecting) {
        client.sendRealtimeInput([{
          mimeType: "audio/pcm;rate=16000",
          data: base64,
        }]);
      } else if (!connected) {
        inputBufferRef.current.push({
          mimeType: "audio/pcm;rate=16000",
          data: base64
        });
      }
    };

    if (connected && !muted && !isReconnecting) {
      audioRecorder.on("data", onData).on("volume", setInVolume).start();
      
      // Flush buffered inputs after reconnection
      if (inputBufferRef.current.length > 0) {
        inputBufferRef.current.forEach(input => {
          client.sendRealtimeInput([input]);
        });
        inputBufferRef.current = [];
      }
    } else {
      audioRecorder.stop();
    }

    return () => {
      audioRecorder.off("data", onData).off("volume", setInVolume);
    };
  }, [connected, client, muted, audioRecorder, isReconnecting]);

// Handle video stream during reconnections
useEffect(() => {
  if (!connected || isReconnecting) return;

  let timeoutId = -1;
  const canvas = renderCanvasRef.current;
  const video = videoRef.current;

  function sendVideoFrame() {
    if (!video || !canvas || !activeVideoStream) return;

    const ctx = canvas.getContext("2d")!;
    canvas.width = video.videoWidth * 0.25;
    canvas.height = video.videoHeight * 0.25;
    
    if (canvas.width + canvas.height > 0) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const base64 = canvas.toDataURL("image/jpeg", 1.0);
      const data = base64.slice(base64.indexOf(",") + 1);
      client.sendRealtimeInput([{ mimeType: "image/jpeg", data }]);
    }
    
      if (connected) {
        timeoutId = window.setTimeout(sendVideoFrame, 1000 / 0.5);
      }
    }
    if (connected && activeVideoStream !== null) {
      requestAnimationFrame(sendVideoFrame);
    }
    return () => {
      clearTimeout(timeoutId);
    };
  }, [connected, activeVideoStream, client, videoRef]);

  //handler for swapping from one video-stream to the next
  const changeStreams = (next?: UseMediaStreamResult) => async () => {
    if (next) {
      const mediaStream = await next.start();
      setActiveVideoStream(mediaStream);
      onVideoStreamChange(mediaStream);
    } else {
      setActiveVideoStream(null);
      onVideoStreamChange(null);
    }

    videoStreams.filter((msr) => msr !== next).forEach((msr) => msr.stop());
  };

  return (
    <section className="control-tray">
      <canvas style={{ display: "none" }} ref={renderCanvasRef} />

        {/* Reconnection status badge */}
        {isReconnecting && (
        <div className="reconnection-status">
          <span className="reconnection-spinner">↻</span>
          Reconnecting...
        </div>
      )}
      <nav className={cn("actions-nav", { disabled: !connected })}>
        <button
          className={cn("action-button mic-button")}
          onClick={() => setMuted(!muted)}
        >

          
          {!muted ? (
            <span className="material-symbols-outlined filled">mic</span>
          ) : (
            <span className="material-symbols-outlined filled">mic_off</span>
          )}
        </button>

        <div className="action-button no-action outlined">
          <AudioPulse volume={volume} active={connected} hover={false} />
        </div>

        {supportsVideo && (
          <>
            <MediaStreamButton
              isStreaming={screenCapture.isStreaming}
              start={changeStreams(screenCapture)}
              stop={changeStreams()}
              onIcon="cancel_presentation"
              offIcon="present_to_all"
            />
            <MediaStreamButton
              isStreaming={webcam.isStreaming}
              start={changeStreams(webcam)}
              stop={changeStreams()}
              onIcon="videocam_off"
              offIcon="videocam"
            />
          </>
        )}
        {children}
      </nav>

      <div className={cn("connection-container", { connected })}>
        <button
          ref={connectButtonRef}
          className={cn("action-button connect-toggle", { 
            connected,
            disabled: isReconnecting
          })}
          onClick={connected ? disconnect : connect}
          disabled={isReconnecting}
        >
          <span className="material-symbols-outlined filled">
            {isReconnecting ? "sync" : connected ? "pause" : "play_arrow"}
          </span>
        </button>
        <span className="text-indicator">
          {isReconnecting ? "Reconnecting..." : "Streaming"}
        </span>
      </div>
      
      {enableEditingSettings && <SettingsDialog />}
    </section>
  );
}

export default memo(ControlTray);
