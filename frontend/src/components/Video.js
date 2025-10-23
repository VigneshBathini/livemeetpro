import React, { useState, useRef, useEffect, useCallback } from 'react';
import io from 'socket.io-client';
import SimplePeer from 'simple-peer';
import * as faceapi from 'face-api.js';
import { v4 as uuidv4 } from 'uuid';

const SIGNALING_SERVER_URL = 'https://livemeet-ribm.onrender.com' || 'https://localhost:3000';

class ErrorBoundary extends React.Component {
  state = { hasError: false };

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return <div className="error-message">Something went wrong. Please refresh the page.</div>;
    }
    return this.props.children;
  }
}

const Alert = ({ message, type, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 5000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className={`alert alert-${type}`}>
      {message}
      <button onClick={onClose} className="alert-close">×</button>
    </div>
  );
};

const Video = () => {
  const [roomId, setRoomId] = useState('');
  const [localStream, setLocalStream] = useState(null); 
  const [screenStream, setScreenStream] = useState(null); 
  const [inRoom, setInRoom] = useState(false);
  const [peers, setPeers] = useState({});
  const [debugLog, setDebugLog] = useState([]);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [isAudioOn, setIsAudioOn] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState({});
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [showDebug, setShowDebug] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [userName, setUserName] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [participantControls, setParticipantControls] = useState({});
  const [alerts, setAlerts] = useState([]);
  
  const lastTabSwitch = useRef(0);
  const renegotiationQueue = useRef({});
  const pendingRemoteStreams = useRef({});
  const videoStreamCount = useRef({});
  const socketRef = useRef();
  const userVideoRef = useRef({}); 
  const peerVideoRefs = useRef({}); 
  const pendingCandidates = useRef({});
  const peersRef = useRef({});
  const chatRef = useRef();
  const detectionIntervals = useRef({});
  

  const screenShareTrackRef = useRef(null);
  const screenShareCleanupRef = useRef(null);
  const screenShareActiveRef = useRef(false);

  const addAlert = useCallback((message, type = 'error') => {
    const id = Date.now();
    setAlerts((prev) => [...prev, { id, message, type }]);
  }, []);

  const removeAlert = useCallback((id) => {
    setAlerts((prev) => prev.filter((alert) => alert.id !== id));
  }, []);

  const logDebug = useCallback((msg) => {
    console.log(msg);
    setDebugLog((prev) => [...prev, msg].slice(-50));
  }, []);

  const shortId = (id) => id.slice(0, 8);

  
  const cleanupScreenSharing = useCallback(async () => {
    logDebug('Starting comprehensive screen sharing cleanup...');
    
    screenShareActiveRef.current = false;
    
    
    if (screenStream) {
      screenStream.getTracks().forEach((track) => {
        track.onended = null;
        if (track.readyState === 'live') {
          track.stop();
        }
      });
      setScreenStream(null);
    }

    
    if (screenShareTrackRef.current) {
      screenShareTrackRef.current.onended = null;
      screenShareTrackRef.current = null;
    }

    
    const cleanupPromises = Object.entries(peersRef.current).map(async ([peerId, peer]) => {
      if (peer && peer._pc) {
        try {
          
          const screenSender = peer._pc.getSenders().find((s) => s.track?._type === 'screen');
          if (screenSender) {
            await screenSender.replaceTrack(null);
            logDebug(`Removed screen track from peer ${peerId}`);
          }

      
          if (peer._pc.signalingState === 'stable') {
            await renegotiatePeer(peer, peerId, 0, true);
          }
        } catch (err) {
          logDebug(`Error cleaning up screen track for peer ${peerId}: ${err.message}`);
        }
      }
    });

    await Promise.all(cleanupPromises);

    
    if (userVideoRef.current?.screen) {
      userVideoRef.current.screen.srcObject = null;
    }

  
    if (screenShareCleanupRef.current) {
      screenShareCleanupRef.current();
      screenShareCleanupRef.current = null;
    }

    logDebug('Screen sharing cleanup completed');
  }, [screenStream]);

  
  useEffect(() => {
    if (screenStream && userVideoRef.current.screen) {
      logDebug('Assigning screen share stream to local video element.');
      userVideoRef.current.screen.srcObject = screenStream;
      userVideoRef.current.screen.play().catch((err) => {
        logDebug(`Error playing local screen share stream: ${err.message}`);
        addAlert('Failed to play local screen share stream.', 'error');
      });
    } else if (screenStream && !userVideoRef.current.screen) {
      logDebug('Screen share video element not yet available.');
    }

   
    screenShareCleanupRef.current = () => {
      if (userVideoRef.current?.screen) {
        userVideoRef.current.screen.srcObject = null;
      }
    };

    return () => {
      if (screenShareCleanupRef.current) {
        screenShareCleanupRef.current();
      }
    };
  }, [screenStream, logDebug, addAlert]);

  useEffect(() => {
    if (!isScreenSharing && userVideoRef.current.screen) {
      userVideoRef.current.screen.srcObject = null;
    }
  }, [isScreenSharing]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && !isScreenSharing && participantControls[socketRef.current.id]?.proctor) {
        logDebug('Tab switch detected during proctor mode and screen sharing');
        addAlert('Tab switching detected. Please remain on the current tab during proctor mode.', 'warning');
        
        socketRef.current.emit('tab-switch-alert', {
          roomId,
          userId: socketRef.current.id,
          userName,
          message: `${userName} switched tabs during proctor mode.`,
        });
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isScreenSharing, participantControls, roomId, userName, logDebug, addAlert]);

  useEffect(() => {
    const isSupportedBrowser = !!window.RTCPeerConnection && !!navigator.mediaDevices.getUserMedia;
    if (!isSupportedBrowser) {
      logDebug('Warning: Your browser may not fully support WebRTC.');
      addAlert('Please use a modern browser like Chrome or Firefox for video calls.', 'error');
    }

    const loadFaceApiModels = async () => {
      try {
        await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri('/weights'),
          faceapi.nets.faceLandmark68Net.loadFromUri('/weights'),
        ]);
        logDebug('Face-api.js models loaded successfully.');
        addAlert('Face detection models loaded successfully.', 'success');
      } catch (err) {
        logDebug(`Error loading face-api.js models: ${err.message}`);
        addAlert('Failed to load face detection models.', 'error');
      }
    };
    loadFaceApiModels();
  }, [logDebug, addAlert]);	
  
  useEffect(() => {
    socketRef.current = io(SIGNALING_SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
    });

    socketRef.current.on('connect', () => {
      logDebug('Connected to signaling server');
      addAlert('Connected to server.', 'success');
      if (inRoom) {
        logDebug('Rejoining room after reconnect');
        socketRef.current.emit('join-room', roomId, socketRef.current.id, userName, isHost);
      }
    });
    socketRef.current.on('connect_error', (err) => {
      logDebug(`Socket connection error: ${err.message}`);
      addAlert('Connection error. Retrying...', 'error');
      setTimeout(() => socketRef.current.connect(), 2000);
    });
    socketRef.current.on('reconnect', (attempt) => {
      logDebug(`Reconnected after attempt ${attempt}`);
      addAlert(`Reconnected to server after ${attempt} attempts.`, 'success');
    });
    socketRef.current.on('reconnect_failed', () => {
      logDebug('Reconnection failed. Retrying manually...');
      addAlert('Reconnection failed. Retrying...', 'error');
      socketRef.current.connect();
    });

    socketRef.current.on('user-joined', handleUserJoined);
    socketRef.current.on('offer', handleOffer);
    socketRef.current.on('answer', handleAnswer);
    socketRef.current.on('ice-candidate', handleIceCandidate);
    socketRef.current.on('user-left', handleUserLeft);
    socketRef.current.on('chat-message', handleChatMessage);
    socketRef.current.on('toggle-media', handleToggleMedia);
    socketRef.current.on('face-detection-alert', (data) => {
      if (data.userId === socketRef.current.id) {
        logDebug(`Received face detection alert: ${data.message}`);
        addAlert(data.message, 'warning');
      }
    });
    socketRef.current.on('tab-switch-alert', (data) => {
      if (isHost) {
        logDebug(`Tab switch alert from ${data.userId} (${data.userName}): ${data.message}`);
        addAlert(data.message, 'warning');
      }
    });
    socketRef.current.on('toggle-proctor', (data) => {
      if (data.userId === socketRef.current.id) {
        setParticipantControls((prev) => ({
          ...prev,
          [socketRef.current.id]: {
            ...prev[socketRef.current.id],
            proctor: data.proctor,
          },
        }));
        logDebug(`Proctor mode ${data.proctor ? 'enabled' : 'disabled'} by host`);
        addAlert(`Proctor mode ${data.proctor ? 'enabled' : 'disabled'} by host.`, 'info');
      }
    });
    socketRef.current.on('screen-share-status', (data) => {
      logDebug(`Received screen share status from ${data.userId} (${data.userName}): isScreenSharing=${data.isScreenSharing}`);
      setConnectionStatus((prev) => ({
        ...prev,
        [data.userId]: {
          ...prev[data.userId],
          streams: {
            ...prev[data.userId]?.streams,
            screen: data.isScreenSharing,
          },
        },
      }));
      addAlert(`${data.userName} ${data.isScreenSharing ? 'started' : 'stopped'} screen sharing.`, 'info');
    });

    const testIceServers = async () => {
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
          {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
        ],
      });
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          logDebug(`ICE candidate generated: ${JSON.stringify(e.candidate)}`);
        }
      };
      pc.createDataChannel('test');
      await pc.createOffer().then((offer) => pc.setLocalDescription(offer));
      setTimeout(() => pc.close(), 5000);
    };
    testIceServers();

    return () => {
      socketRef.current.disconnect();
    };
  }, [logDebug, roomId, inRoom, userName, isHost, addAlert]);

  
  useEffect(() => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack._type = 'camera';
        logDebug(`Tagged camera track with type: camera (ID: ${videoTrack.id})`);
      }
    }
  }, [localStream, logDebug]);

  useEffect(() => {
    if (!localStream || !inRoom) return;

    if (userVideoRef.current.camera) {
      userVideoRef.current.camera.srcObject = localStream;
      userVideoRef.current.camera.play().catch((err) => {
        logDebug(`Error playing local camera stream: ${err.message}`);
        addAlert('Failed to play local camera stream.', 'error');
      });
      logDebug('Local camera stream assigned to video element.');
    }
  }, [localStream, inRoom, logDebug, addAlert]);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (!isHost) return;

    Object.keys(participantControls).forEach((userId) => {
      const proctorEnabled = participantControls[userId]?.proctor;
      const existingInterval = detectionIntervals.current[userId];

      if (proctorEnabled && !existingInterval) {
        const videoElement = peerVideoRefs.current[userId]?.camera;
        if (videoElement && videoElement.srcObject) {
          const interval = setInterval(async () => {
            try {
              const detections = await faceapi.detectAllFaces(videoElement).withFaceLandmarks();
              logDebug(`Face detection for ${userId} (camera stream): ${detections.length} faces detected`);
              if (detections.length === 0) {
                const participantName = connectionStatus[userId]?.userName || shortId(userId);
                const hostMessage = `No face detected for ${participantName} on camera stream.`;
                const participantMessage = 'No face detected. Please ensure you are visible on your camera.';
                addAlert(hostMessage, 'warning');
                socketRef.current.emit('face-detection-alert', {
                  roomId,
                  userId,
                  message: participantMessage,
                });
                logDebug(`Sent face detection alert to ${userId}`);
              }
              else if(detections.length >= 2){
                  const participantName = connectionStatus[userId]?.userName || shortId(userId);
                const hostMessage = `Multiple face detected for ${participantName} on camera stream.`;
                const participantMessage = 'Multiple face detected. Please ensure you are visible on your camera.';
                addAlert(hostMessage, 'warning');
                socketRef.current.emit('face-detection-alert', {
                  roomId,
                  userId,
                  message: participantMessage,
                });
              }
            } 
            catch (err) {
              logDebug(`Face detection error for ${userId} (camera stream): ${err.message}`);
              const participantName = connectionStatus[userId]?.userName || shortId(userId);
              const hostMessage = `Face detection error for ${participantName} on camera stream.`;
              const participantMessage = 'Face detection error. Please check your camera feed.';
              addAlert(hostMessage, 'error');
              socketRef.current.emit('face-detection-alert', {
                roomId,
                userId,
                message: participantMessage,
              });
            }
          }, 5000);
          detectionIntervals.current[userId] = interval;
          logDebug(`Started face detection for ${userId} on camera stream`);
        } else {
          logDebug(`Camera video element not ready for ${userId}`);
        }
      } else if (!proctorEnabled && existingInterval) {
        clearInterval(existingInterval);
        delete detectionIntervals.current[userId];
        logDebug(`Stopped face detection for ${userId}`);
      }
    });

    return () => {
      Object.values(detectionIntervals.current).forEach((interval) => clearInterval(interval));
      detectionIntervals.current = {};
    };
  }, [participantControls, connectionStatus, logDebug, isHost, addAlert]);

  
  useEffect(() => {
    const interval = setInterval(() => {
      Object.keys(pendingRemoteStreams.current).forEach(userId => {
        const pending = Object.values(pendingRemoteStreams.current[userId] || {}).filter(s => s);
        if (pending.length > 0) {
          logDebug(`Pending streams for ${userId}: ${pending.length}`);
        }
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [logDebug]);

  const checkPermissions = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      stream.getTracks().forEach((track) => track.stop());
      return true;
    } catch (err) {
      logDebug(`Permission check failed: ${err.name} - ${err.message}`);
      addAlert('Camera/microphone permissions denied.', 'error');
      return false;
    }
  };

  const createRoom = async () => {
    if (!userName.trim()) {
      logDebug('Please enter a username.');
      addAlert('Please enter a username.', 'error');
      return;
    }

    if (!(await checkPermissions())) {
      logDebug('Camera/microphone permissions denied.');
      return;
    }

    const newRoomId = uuidv4();
    setRoomId(newRoomId);
    setIsHost(true);
    logDebug(`Created room: ${newRoomId} as host (${userName})`);
    addAlert(`Room created: ${newRoomId}`, 'success');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true } 
      });
      
      stream.getVideoTracks().forEach(track => {
        track.enabled = true;
        track._type = 'camera';
      });
      stream.getAudioTracks().forEach(track => track.enabled = true);
      
      setLocalStream(stream);
      setIsVideoOn(true);
      setIsAudioOn(true);
      logDebug('Local camera stream acquired successfully.');
      logDebug(`Local camera stream tracks: ${stream.getTracks().map((t) => `${t.kind}:${t.enabled}`).join(', ')}`);
    } catch (err) {
      logDebug(`Error accessing media: ${err.name} - ${err.message}`);
      addAlert('Failed to access camera/microphone. Check permissions.', 'error');
      return;
    }

    setParticipantControls((prev) => ({
      ...prev,
      [socketRef.current.id]: { video: true, audio: true, proctor: false },
    }));

    socketRef.current.emit('join-room', newRoomId, socketRef.current.id, userName, true);
    setInRoom(true);
  };

  const joinRoom = async () => {
    if (!roomId.trim()) {
      logDebug('Please enter a Room ID.');
      addAlert('Please enter a Room ID.', 'error');
      return;
    }
    if (!userName.trim()) {
      logDebug('Please enter a username.');
      addAlert('Please enter a username.', 'error');
      return;
    }

    if (!(await checkPermissions())) {
      logDebug('Camera/microphone permissions denied.');
      return;
    }

    logDebug(`Joining room: ${roomId} as ${userName}`);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true } 
      });
      
      stream.getVideoTracks().forEach(track => {
        track.enabled = true;
        track._type = 'camera';
      });
      stream.getAudioTracks().forEach(track => track.enabled = true);
      
      setLocalStream(stream);
      setIsVideoOn(true);
      setIsAudioOn(true);
      logDebug('Local camera stream acquired successfully.');
      logDebug(`Local camera stream tracks: ${stream.getTracks().map((t) => `${t.kind}:${t.enabled}`).join(', ')}`);
      addAlert(`Joined room: ${roomId}`, 'success');
    } catch (err) {
      logDebug(`Error accessing media: ${err.name} - ${err.message}`);
      addAlert('Failed to access camera/microphone. Check permissions.', 'error');
      return;
    }

    setParticipantControls((prev) => ({
      ...prev,
      [socketRef.current.id]: { video: true, audio: true, proctor: false },
    }));

    socketRef.current.emit('join-room', roomId, socketRef.current.id, userName, false);
    setInRoom(true);
  };

  const toggleVideo = async () => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoOn(videoTrack.enabled);
        logDebug(`Camera track ${videoTrack.enabled ? 'enabled' : 'disabled'}`);
        addAlert(`Camera ${videoTrack.enabled ? 'enabled' : 'disabled'}`, 'info');

        Object.values(peersRef.current).forEach((peer) => {
          const sender = peer._pc.getSenders().find((s) => s.track?.kind === 'video' && !s.track.label?.includes('screen'));
          if (sender) {
            if (videoTrack.enabled) {
              sender.replaceTrack(videoTrack).catch((err) => {
                logDebug(`Error replacing camera track for peer ${peer._id || 'unknown'}: ${err.message}`);
                addAlert('Failed to update camera stream.', 'error');
              });
            } else {
              sender.replaceTrack(null).catch((err) => {
                logDebug(`Error removing camera track for peer ${peer._id || 'unknown'}: ${err.message}`);
                addAlert('Failed to stop camera stream.', 'error');
              });
            }
            logDebug(`Updated camera track for peer ${peer._id || 'unknown'}: enabled=${videoTrack.enabled}`);
            renegotiatePeer(peer, peer._id);
          }
        });

        if (!isHost && socketRef.current?.connected) {
          socketRef.current.emit('toggle-media', {
            roomId,
            userId: socketRef.current.id,
            video: videoTrack.enabled,
            audio: isAudioOn,
          });
        }
      } else {
        try {
          const newStream = await navigator.mediaDevices.getUserMedia({ 
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false 
          });
          const newVideoTrack = newStream.getVideoTracks()[0];
          newVideoTrack._type = 'camera';
          setLocalStream(newStream);
          setIsVideoOn(true);
          logDebug('Reacquired camera stream successfully.');
          addAlert('Camera stream reacquired.', 'success');

          Object.values(peersRef.current).forEach((peer) => {
            const sender = peer._pc.getSenders().find((s) => s.track?.kind === 'video' && !s.track.label?.includes('screen'));
            if (sender) {
              sender.replaceTrack(newVideoTrack).catch((err) => {
                logDebug(`Error replacing new camera track for peer ${peer._id || 'unknown'}: ${err.message}`);
                addAlert('Failed to update camera stream.', 'error');
              });
              renegotiatePeer(peer, peer._id);
            }
          });

          if (userVideoRef.current?.camera) {
            userVideoRef.current.camera.srcObject = newStream;
            userVideoRef.current.camera.play().catch((err) => {
              logDebug(`Error playing reacquired camera stream: ${err.message}`);
              addAlert('Failed to play reacquired camera stream.', 'error');
            });
          }

          if (!isHost && socketRef.current?.connected) {
            socketRef.current.emit('toggle-media', {
              roomId,
              userId: socketRef.current.id,
              video: true,
              audio: isAudioOn,
            });
          }
        } catch (err) {
          logDebug(`Error reacquiring camera stream: ${err.message}`);
          addAlert('Failed to reacquire camera stream.', 'error');
        }
      }
    }
  };

  const toggleAudio = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioOn(audioTrack.enabled);
        logDebug(`Audio track ${audioTrack.enabled ? 'enabled' : 'disabled'}`);
        addAlert(`Audio ${audioTrack.enabled ? 'enabled' : 'disabled'}`, 'info');

        if (!isHost && socketRef.current?.connected) {
          socketRef.current.emit('toggle-media', {
            roomId,
            userId: socketRef.current.id,
            video: isVideoOn,
            audio: audioTrack.enabled,
          });
        }
      }
    }
  };

  // FIXED: Enhanced screen sharing with proper cleanup and track management
  const toggleScreenShare = async () => {
    if (!isScreenSharing) {
      try {
        // Wait for any ongoing cleanup to complete
        if (screenShareActiveRef.current) {
          await cleanupScreenSharing();
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        const isProctorEnabled = participantControls[socketRef.current?.id]?.proctor || false;
        addAlert(
          isProctorEnabled
            ? 'Proctor mode requires sharing your entire screen. Tab or window sharing is not allowed.'
            : 'Select a screen, window, or tab to share.',
          'info'
        );

        const videoConstraints = isProctorEnabled
          ? { video: { displaySurface: 'monitor', cursor: 'never' } }
          : { video: true };

        const newScreenStream = await navigator.mediaDevices.getDisplayMedia(videoConstraints);
        const newScreenTrack = newScreenStream.getVideoTracks()[0];
        newScreenTrack._type = 'screen';
        const settings = newScreenTrack.getSettings();
        logDebug(`Screen share settings: ${JSON.stringify(settings)}`);
        logDebug(`Tagged screen track with type: screen (ID: ${newScreenTrack.id})`);

        if (isProctorEnabled && settings.displaySurface !== 'monitor') {
          newScreenTrack.stop();
          newScreenStream.getTracks().forEach(track => track.stop());
          addAlert('Proctor mode requires sharing the entire screen, not a specific tab or window.', 'error');
          return;
        }

 
        screenShareActiveRef.current = true;
        screenShareTrackRef.current = newScreenTrack;

        
        const addTrackPromises = Object.entries(peersRef.current).map(async ([peerId, peer]) => {
          if (peer && peer._pc && peer._pc.signalingState === 'stable') {
            try {
             
              const existingScreenSender = peer._pc.getSenders().find(s => s.track?._type === 'screen');
              if (existingScreenSender) {
                await existingScreenSender.replaceTrack(null);
                logDebug(`Cleaned up existing screen track for peer ${peerId}`);
                await new Promise(resolve => setTimeout(resolve, 100)); 
              }

            
              peer._pc.addTrack(newScreenTrack, newScreenStream);
              logDebug(`Added new screen track to peer ${peerId}`);
              
              
              await new Promise(resolve => setTimeout(resolve, 200));
              
              
              await renegotiatePeer(peer, peerId, 0, true);
            } catch (err) {
              logDebug(`Error adding screen track to peer ${peerId}: ${err.message}`);
            }
          }
        });

        await Promise.all(addTrackPromises);


        setScreenStream(newScreenStream);
        setIsScreenSharing(true);
        addAlert(isProctorEnabled ? 'Screen sharing started (entire screen).' : 'Screen sharing started.', 'success');

      
        const sendScreenShareStatus = (attempt = 1) => {
          if (socketRef.current?.connected) {
            socketRef.current.emit('screen-share-status', {
              roomId,
              userName,
              isScreenSharing: true,
            });
            logDebug(`Sent screen-share-status (start) to room ${roomId}`);
          } else if (attempt <= 5) {
            logDebug(`Socket not connected, retrying screen-share-status (start) (${attempt}/5)...`);
            setTimeout(() => sendScreenShareStatus(attempt + 1), 1000);
          } else {
            logDebug(`Failed to send screen-share-status (start) after 5 attempts`);
            addAlert('Failed to notify others of screen sharing start.', 'error');
          }
        };
        sendScreenShareStatus();

        
        const handleTrackEnd = () => {
          logDebug('Screen share track ended by browser/system');
          stopScreenShare();
        };
        
        newScreenTrack.onended = handleTrackEnd;

      } catch (err) {
        logDebug(`Error starting screen share: ${err.message}`);
        screenShareActiveRef.current = false;
        screenShareTrackRef.current = null;
        if (err.name === 'NotAllowedError') {
          addAlert('Screen sharing permission denied.', 'error');
        } else if (err.name === 'NotSupportedError') {
          addAlert('Browser does not support entire screen sharing. Use Chrome or Edge.', 'error');
        } else {
          addAlert('Failed to start screen sharing.', 'error');
        }
      }
    } else {
      stopScreenShare();
    }
  };

 
  const stopScreenShare = async () => {
    logDebug('Stopping screen share with full cleanup...');
    
    setIsScreenSharing(false);
    
    await cleanupScreenSharing();

    addAlert('Screen sharing stopped.', 'info');

    
    const sendScreenShareStatus = (attempt = 1) => {
      if (socketRef.current?.connected) {
        socketRef.current.emit('screen-share-status', {
          roomId,
          userName,
          isScreenSharing: false,
        });
        logDebug(`Sent screen-share-status (stop) to room ${roomId}`);
      } else if (attempt <= 5) {
        logDebug(`Socket not connected, retrying screen-share-status (stop) (${attempt}/5)...`);
        setTimeout(() => sendScreenShareStatus(attempt + 1), 1000);
      } else {
        logDebug(`Failed to send screen-share-status (stop) after 5 attempts`);
        addAlert('Failed to notify others of screen sharing stop.', 'error');
      }
    };
    sendScreenShareStatus();
    
    logDebug('Screen share stopped completely');
  };

  
  const renegotiationPeer = async (peer, userId, retryCount = 0, isCleanup = false) => {
    const queueKey = `${userId}_${isCleanup ? 'cleanup' : 'regular'}`;
    
    if (renegotiationQueue.current[queueKey]) {
      logDebug(`Renegotiation for ${userId} (${isCleanup ? 'cleanup' : 'regular'}) already queued, skipping...`);
      return;
    }
    renegotiationQueue.current[queueKey] = true;

    try {
      // Wait for stable state with timeout
      let attempts = 0;
      const maxAttempts = 15;
      while (peer._pc.signalingState !== 'stable' && attempts < maxAttempts) {
        logDebug(`Waiting for stable state for ${userId} (${attempts + 1}/${maxAttempts}), current: ${peer._pc.signalingState}`);
        await new Promise(resolve => setTimeout(resolve, 300));
        attempts++;
      }

      if (peer._pc.signalingState !== 'stable') {
        logDebug(`Peer ${userId} not in stable state after ${maxAttempts} attempts (state: ${peer._pc.signalingState})`);
        throw new Error(`Peer not in stable state after ${maxAttempts} attempts`);
      }

      const offerOptions = {
        offerToReceiveVideo: true,
        offerToReceiveAudio: true
      };

      const offer = await peer._pc.createOffer(offerOptions);
      await peer._pc.setLocalDescription(offer);
      logDebug(`Sending ${isCleanup ? 'cleanup' : 'new'} offer to ${userId} after track change: ${JSON.stringify(offer).slice(0, 100)}...`);
      socketRef.current.emit('offer', { signal: offer, to: userId });

      const answerTimeout = setTimeout(() => {
        logDebug(`Timeout waiting for answer from ${userId} (${isCleanup ? 'cleanup' : 'regular'})`);
        //addAlert(`No answer received from ${connectionStatus[userId]?.userName || shortId(userId)} for ${isCleanup ? 'cleanup' : 'renegotiation'}.`, 'error');
        delete renegotiationQueue.current[queueKey];
      }, 12000);

      socketRef.current.once(`answer_${Date.now()}`, (data) => {
        if (data.from === userId) {
          clearTimeout(answerTimeout);
          logDebug(`Received answer from ${userId} for ${isCleanup ? 'cleanup' : 'renegotiation'}`);
          peer.signal(data.signal);
          delete renegotiationQueue.current[queueKey];
        }
      });

      
      socketRef.current.on('answer', (data) => {
        if (data.from === userId) {
          clearTimeout(answerTimeout);
          logDebug(`Received answer from ${userId} for ${isCleanup ? 'cleanup' : 'renegotiation'}`);
          peer.signal(data.signal);
          delete renegotiationQueue.current[queueKey];
        }
      });

    } catch (err) {
      logDebug(`Error renegotiating peer connection for ${userId} (${isCleanup ? 'cleanup' : 'regular'}): ${err.message}`);
      if (retryCount < 3) {
        logDebug(`Retrying renegotiation for ${userId} (${retryCount + 1}/3)...`);
        setTimeout(() => {
          delete renegotiationQueue.current[queueKey];
          renegotiationPeer(peer, userId, retryCount + 1, isCleanup);
        }, 1000);
      } else {
        addAlert(`Failed to renegotiate connection with ${connectionStatus[userId]?.userName || shortId(userId)}.`, 'error');
        delete renegotiationQueue.current[queueKey];
      }
    }
  };


  const assignPeerStream = (userId, streamType, singleTrackStream, attempt = 1) => {
    const videoElement = peerVideoRefs.current[userId]?.[streamType];
    
    if (videoElement && !videoElement.srcObject) { 
      videoElement.srcObject = singleTrackStream;
      videoElement.play().catch((err) => {
        logDebug(`Error playing ${streamType} stream for ${userId}: ${err.message}`);
        addAlert(`Failed to play ${streamType} stream for ${connectionStatus[userId]?.userName || shortId(userId)}.`, 'error');
      });
      logDebug(`Assigned ${streamType} stream to video element for ${userId}`);
      setConnectionStatus((prev) => ({
        ...prev,
        [userId]: {
          ...prev[userId],
          status: 'connected',
          streams: { ...prev[userId]?.streams, [streamType]: true },
        },
      }));

      if (pendingRemoteStreams.current[userId]) {
        pendingRemoteStreams.current[userId][streamType] = null;
      }
    } else if (attempt <= 20 && !videoElement) {
      logDebug(`Video element for ${userId} (${streamType}) not ready, retrying (${attempt}/20)...`);
      setTimeout(() => assignPeerStream(userId, streamType, singleTrackStream, attempt + 1), 500);
    } else if (videoElement && videoElement.srcObject && attempt === 1) {
      logDebug(`Video element for ${userId} (${streamType}) already has stream, skipping assignment`);
    } else {
      logDebug(`Failed to assign ${streamType} stream for ${userId} after 20 attempts`);
      addAlert(`Failed to assign ${streamType} stream for ${connectionStatus[userId]?.userName || shortId(userId)}. Check browser console.`, 'error');
    }
  };


const renegotiatePeer = async (peer, userId, retryCount = 0, isCleanup = false) => {
  const queueKey = `${userId}_${isCleanup ? 'cleanup' : 'regular'}`;
  
  if (renegotiationQueue.current[queueKey]) {
    logDebug(`Renegotiation for ${userId} (${isCleanup ? 'cleanup' : 'regular'}) already queued, skipping...`);
    return;
  }
  renegotiationQueue.current[queueKey] = true;

  try {
   
    let attempts = 0;
    const maxAttempts = 20;
    while (peer._pc.signalingState !== 'stable' && attempts < maxAttempts) {
      logDebug(`Waiting for stable state for ${userId} (${attempts + 1}/${maxAttempts}), current: ${peer._pc.signalingState}`);
      await new Promise(resolve => setTimeout(resolve, 300));
      attempts++;
    }

    if (peer._pc.signalingState !== 'stable') {
      logDebug(`Peer ${userId} not in stable state after ${maxAttempts} attempts (state: ${peer._pc.signalingState})`);
      throw new Error(`Peer not in stable state after ${maxAttempts} attempts`);
    }

    const offerOptions = {
      offerToReceiveVideo: true,
      offerToReceiveAudio: true,
      iceRestart: isCleanup, 
    };

    const offer = await peer._pc.createOffer(offerOptions);
    await peer._pc.setLocalDescription(offer);
    logDebug(`Sending ${isCleanup ? 'cleanup' : 'new'} offer to ${userId}: ${JSON.stringify(offer).slice(0, 100)}...`);
    socketRef.current.emit('offer', { signal: offer, to: userId });

    const answerTimeout = setTimeout(() => {
      logDebug(`Timeout waiting for answer from ${userId} (${isCleanup ? 'cleanup' : 'regular'})`);
      //addAlert(`No answer received from ${connectionStatus[userId]?.userName || shortId(userId)} for ${isCleanup ? 'cleanup' : 'renegotiation'}.`, 'error');
      delete renegotiationQueue.current[queueKey];
    }, 15000);

    socketRef.current.once(`answer_${userId}_${Date.now()}`, (data) => {
      if (data.from === userId) {
        clearTimeout(answerTimeout);
        logDebug(`Received answer from ${userId} for ${isCleanup ? 'cleanup' : 'renegotiation'}`);
        peer.signal(data.signal);
        delete renegotiationQueue.current[queueKey];
      }
    });

  } catch (err) {
    logDebug(`Error renegotiating peer connection for ${userId} (${isCleanup ? 'cleanup' : 'regular'}): ${err.message}`);
    if (retryCount < 3) {
      logDebug(`Retrying renegotiation for ${userId} (${retryCount + 1}/3)...`);
      setTimeout(() => {
        delete renegotiationQueue.current[queueKey];
        renegotiatePeer(peer, userId, retryCount + 1, isCleanup);
      }, 1500);
    } else {
      addAlert(`Failed to renegotiate connection with ${connectionStatus[userId]?.userName || shortId(userId)}.`, 'error');
      delete renegotiationQueue.current[queueKey];
    }
  }
};


  const createPeer = (userId, initiator) => {
    logDebug(`Creating peer for ${userId}, initiator: ${initiator}`);
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      stream: localStream,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
          {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
        ],
      },
    });

    peer._id = userId; 

    // Add screen sharing track if active
    if (isScreenSharing && screenStream && screenShareTrackRef.current) {
      const screenTrack = screenShareTrackRef.current;
      if (screenTrack && screenTrack.readyState === 'live') {
        try {
          peer._pc.addTrack(screenTrack, screenStream);
          logDebug(`Added screen share track to new peer ${userId}`);
          // Delay renegotiation for new peer
          setTimeout(() => renegotiatePeer(peer, userId), 500);
        } catch (err) {
          logDebug(`Error adding screen track to new peer ${userId}: ${err.message}`);
        }
      }
    }

    peer.on('signal', (signal) => {
      setTimeout(() => {
        if (signal.type === 'offer') {
          socketRef.current.emit('offer', { signal, to: userId });
          logDebug(`Sent offer to ${userId}: ${JSON.stringify(signal).slice(0, 100)}...`);
        } else if (signal.type === 'answer') {
          socketRef.current.emit('answer', { signal, to: userId });
          logDebug(`Sent answer to ${userId}`);
        } else if (signal.candidate) {
          socketRef.current.emit('ice-candidate', { candidate: signal.candidate, to: userId });
          logDebug(`Sent ICE candidate to ${userId}`);
        }
      }, 100);
    });

    peer.on('stream', (stream) => {
      logDebug(`Received stream from ${userId}, tracks: ${stream.getTracks().map((t) => `${t.kind}:${t.label || t.id} (settings: ${JSON.stringify(t.getSettings ? t.getSettings() : 'N/A')})`).join(', ')}`);
      
      if (!peersRef.current[userId]) {
        peersRef.current[userId] = { remoteStreams: {} };
      }
      pendingRemoteStreams.current[userId] = pendingRemoteStreams.current[userId] || { 
        camera: null, 
        screen: null, 
        audio: null
      };

      if (!videoStreamCount.current[userId]) videoStreamCount.current[userId] = 0;

      stream.getTracks().forEach((track) => {
        logDebug(`Processing track ${track.id}: ${track.kind} (enabled: ${track.enabled})`);
        
        if (track.kind === 'audio') {
          if (track.enabled) {
            const audioStream = new MediaStream([track]);
            pendingRemoteStreams.current[userId].audio = audioStream;
            logDebug(`Stored audio stream for ${userId} (track: ${track.id})`);
            
            setTimeout(() => {
       
              const videoElements = [];
              if (peerVideoRefs.current[userId]?.camera) {
                videoElements.push(peerVideoRefs.current[userId].camera);
              }
              if (peerVideoRefs.current[userId]?.screen) {
                videoElements.push(peerVideoRefs.current[userId].screen);
              }
              
              videoElements.forEach(element => {
                if (element && element.srcObject && !element.srcObject.getAudioTracks().length) {
                  const videoTracks = element.srcObject.getVideoTracks();
                  const combinedStream = new MediaStream([...videoTracks, ...audioStream.getAudioTracks()]);
                  element.srcObject = combinedStream;
                }
              });
            }, 200);
          }
        } else if (track.kind === 'video') {
          videoStreamCount.current[userId]++;
      
          const settings = track.getSettings ? track.getSettings() : {};
          let isScreen = (
            track._type === 'screen' || 
            settings.displaySurface ||
            track.label?.toLowerCase().includes('screen') ||
            track.id.includes('screen') ||
            (settings.width >= 1280 && settings.height >= 720 && !settings.facingMode)
          );

          if (!isScreen && videoStreamCount.current[userId] > 1) {
            isScreen = true;
          }

          const streamType = isScreen ? 'screen' : 'camera';
          logDebug(`Classified track ${track.id} as '${streamType}'`);

          const singleTrackStream = new MediaStream([track]);
          pendingRemoteStreams.current[userId][streamType] = singleTrackStream;

          assignPeerStream(userId, streamType, singleTrackStream);
        }
      });

      setTimeout(() => {
        if (pendingRemoteStreams.current[userId]) {
          Object.keys(pendingRemoteStreams.current[userId]).forEach(type => {
            if (pendingRemoteStreams.current[userId][type] && peerVideoRefs.current[userId]?.[type]) {
              assignPeerStream(userId, type, pendingRemoteStreams.current[userId][type]); 
            }
          });
        }
      }, 1000);
    });

    peer.on('connect', () => {
      logDebug(`Peer connection established with ${userId}`);
      setConnectionStatus((prev) => ({ ...prev, [userId]: { ...prev[userId], status: 'connected' } }));
      addAlert(`Connected to ${connectionStatus[userId]?.userName || shortId(userId)}.`, 'success');
    });
    peer.on('error', (err) => {
      logDebug(`Peer error (${userId}): ${err.message}`);
      setConnectionStatus((prev) => ({ ...prev, [userId]: { ...prev[userId], status: 'failed' } }));
      addAlert(`Connection error with ${connectionStatus[userId]?.userName || shortId(userId)}.`, 'error');
    });
    peer.on('close', () => {
      logDebug(`Peer connection closed for ${userId}`);
      setConnectionStatus((prev) => {
        const newStatus = { ...prev };
        delete newStatus[userId];
        return newStatus;
      });
      addAlert(`${connectionStatus[userId]?.userName || shortId(userId)} disconnected.`, 'info');
    });

    peersRef.current[userId] = peer;
    if (pendingCandidates.current[userId]) {
      pendingCandidates.current[userId].forEach((signal) => {
        peer.signal(signal);
      });
      delete pendingCandidates.current[userId];
    }

    return peer;
  };

  const handleUserJoined = (userId, userName, isUserHost) => {
    logDebug(`User joined: ${userId} (${userName}), isHost: ${isUserHost}, current peers: ${Object.keys(peersRef.current)}`);
    setConnectionStatus((prev) => ({
      ...prev,
      [userId]: { 
        status: 'connecting', 
        userName, 
        isHost: isUserHost, 
        streams: { camera: false, screen: false, audio: false }
      },
    }));
    setParticipantControls((prev) => ({ ...prev, [userId]: { video: true, audio: true, proctor: false } }));
    const peer = createPeer(userId, true);
    setPeers((prev) => ({ ...prev, [userId]: peer }));
    addAlert(`${userName} joined the meeting.`, 'info');

    // Notify new user about current screen sharing status
    if (isScreenSharing) {
      setTimeout(() => {
        socketRef.current.emit('screen-share-status', {
          roomId,
          userName,
          isScreenSharing: true,
        });
      }, 1000);
    }
  };

  const handleOffer = (data) => {
    logDebug(`Received offer from ${data.from}: ${JSON.stringify(data.signal).slice(0, 100)}...`);
    let peer = peersRef.current[data.from];
    if (!peer) {
      peer = createPeer(data.from, false);
      peersRef.current[data.from] = peer;
      setPeers((prev) => ({ ...prev, [data.from]: peer }));
    }
    peer.signal(data.signal);
  };

  const handleAnswer = (data) => {
    logDebug(`Received answer from ${data.from}`);
    const peer = peersRef.current[data.from];
    if (peer) {
      peer.signal(data.signal);
    } else {
      logDebug(`No peer for ${data.from}, queuing answer...`);
      if (!pendingCandidates.current[data.from]) {
        pendingCandidates.current[data.from] = [];
      }
      pendingCandidates.current[data.from].push(data.signal);
    }
  };

  const handleIceCandidate = (data) => {
    logDebug(`Received ICE candidate from ${data.from}`);
    const peer = peersRef.current[data.from];
    if (peer) {
      peer.signal({ candidate: data.candidate });
    } else {
      logDebug(`Peer not ready for ICE candidate from ${data.from}, queuing...`);
      if (!pendingCandidates.current[data.from]) {
        pendingCandidates.current[data.from] = [];
      }
      pendingCandidates.current[data.from].push({ candidate: data.candidate });
    }
  };

  const handleUserLeft = (userId) => {
    logDebug(`User left: ${userId}`);
    const userName = connectionStatus[userId]?.userName || shortId(userId);
    setConnectionStatus((prev) => {
      const newStatus = { ...prev };
      delete newStatus[userId];
      return newStatus;
    });
    setParticipantControls((prev) => {
      const newControls = { ...prev };
      delete newControls[userId];
      return newControls;
    });
    if (detectionIntervals.current[userId]) {
      clearInterval(detectionIntervals.current[userId]);
      delete detectionIntervals.current[userId];
    }
    if (pendingRemoteStreams.current[userId]) {
      delete pendingRemoteStreams.current[userId];
    }
    if (peersRef.current[userId]) {
      peersRef.current[userId].destroy();
      delete peersRef.current[userId];
      setPeers((prev) => {
        const newPeers = { ...prev };
        delete newPeers[userId];
        return newPeers;
      });
      if (peerVideoRefs.current[userId]) {
        if (peerVideoRefs.current[userId].camera) peerVideoRefs.current[userId].camera.srcObject = null;
        if (peerVideoRefs.current[userId].screen) peerVideoRefs.current[userId].screen.srcObject = null;
        delete peerVideoRefs.current[userId];
      }
    }
    addAlert(`${userName} left the meeting.`, 'info');
  };

  const handleChatMessage = (data) => {
    logDebug(`Received chat message from ${data.from} (${data.userName}): ${data.message}`);
    setMessages((prev) => {
      const exists = prev.some(
        (msg) => msg.from === data.from && msg.message === data.message && msg.time === new Date().toLocaleTimeString()
      );
      if (exists) return prev;
      return [
        ...prev,
        { from: data.from, userName: data.userName || 'Unknown', message: data.message, time: new Date().toLocaleTimeString() },
      ];
    });
  };

  const handleToggleMedia = (data) => {
    logDebug(`Received toggle-media from host for ${data.userId}: video=${data.video}, audio=${data.audio}`);
    if (data.userId === socketRef.current.id) {
      if (localStream) {
        if (data.video !== undefined) {
          const videoTrack = localStream.getVideoTracks()[0];
          if (videoTrack) {
            videoTrack.enabled = data.video;
            setIsVideoOn(data.video);
            logDebug(`Camera track set to ${data.video ? 'enabled' : 'disabled'} by host`);
            addAlert(`Camera ${data.video ? 'enabled' : 'disabled'} by host.`, 'info');

            Object.values(peersRef.current).forEach((peer) => {
              const sender = peer._pc.getSenders().find((s) => s.track?.kind === 'video' && !s.track.label?.toLowerCase().includes('screen'));
              if (sender) {
                sender.replaceTrack(data.video ? videoTrack : null).catch((err) => {
                  logDebug(`Error updating camera track for peer ${peer._id || 'unknown'}: ${err.message}`);
                  addAlert('Failed to update camera stream.', 'error');
                });
                renegotiatePeer(peer, peer._id);
              }
            });
          } else if (data.video) {
            navigator.mediaDevices.getUserMedia({ 
              video: { width: { ideal: 1280 }, height: { ideal: 720 } },
              audio: false 
            })
              .then((newStream) => {
                const newVideoTrack = newStream.getVideoTracks()[0];
                newVideoTrack._type = 'camera';
                setLocalStream(newStream);
                setIsVideoOn(true);
                logDebug('Reacquired camera stream for host toggle.');
                addAlert('Camera stream reacquired.', 'success');

                Object.values(peersRef.current).forEach((peer) => {
                  const sender = peer._pc.getSenders().find((s) => s.track?.kind === 'video' && !s.track.label?.toLowerCase().includes('screen'));
                  if (sender) {
                    sender.replaceTrack(newVideoTrack).catch((err) => {
                      logDebug(`Error replacing new camera track for peer ${peer._id || 'unknown'}: ${err.message}`);
                      addAlert('Failed to update camera stream.', 'error');
                    });
                    renegotiatePeer(peer, peer._id);
                  }
                });

                if (userVideoRef.current?.camera) {
                  userVideoRef.current.camera.srcObject = newStream;
                  userVideoRef.current.camera.play().catch((err) => {
                    logDebug(`Error playing reacquired camera stream: ${err.message}`);
                    addAlert('Failed to play reacquired camera stream.', 'error');
                  });
                }
              })
              .catch((err) => {
                logDebug(`Error reacquiring camera stream: ${err.message}`);
                addAlert('Failed to reacquire camera stream.', 'error');
              });
          }
        }
        if (data.audio !== undefined) {
          const audioTrack = localStream.getAudioTracks()[0];
          if (audioTrack) {
            audioTrack.enabled = data.audio;
            setIsAudioOn(data.audio);
            logDebug(`Audio track set to ${data.audio ? 'enabled' : 'disabled'} by host`);
            addAlert(`Audio ${data.audio ? 'enabled' : 'disabled'} by host.`, 'info');
          }
        }
      }
    }
  };

  const sendChatMessage = () => {
    if (chatInput.trim()) {
      socketRef.current.emit('chat-message', { roomId, message: chatInput, userName });
      setMessages((prev) => [
        ...prev,
        { from: socketRef.current.id, userName, message: chatInput, time: new Date().toLocaleTimeString() },
      ]);
      setChatInput('');
    }
  };

  const toggleParticipantMedia = (userId, type) => {
    if (!isHost) return;
    setParticipantControls((prev) => {
      const newControls = { ...prev };
      newControls[userId] = {
        ...newControls[userId],
        [type]: !newControls[userId][type],
      };
      if (type === 'video' || type === 'audio') {
        socketRef.current.emit('toggle-media', {
          roomId,
          userId,
          video: type === 'video' ? newControls[userId].video : undefined,
          audio: type === 'audio' ? newControls[userId].audio : undefined,
        });
        logDebug(`Host toggled ${type} for ${userId} to ${newControls[userId][type]}`);
        addAlert(
          `${type.charAt(0).toUpperCase() + type.slice(1)} ${newControls[userId][type] ? 'enabled' : 'disabled'} for ${
            connectionStatus[userId]?.userName || shortId(userId)
          }.`,
          'info'
        );
      } else if (type === 'proctor') {
        socketRef.current.emit('toggle-proctor', {
          roomId,
          userId,
          proctor: newControls[userId].proctor,
        });
        logDebug(`Host toggled proctor for ${userId} to ${newControls[userId][type]}`);
        addAlert(
          `Proctor mode ${newControls[userId][type] ? 'enabled' : 'disabled'} for ${
            connectionStatus[userId]?.userName || shortId(userId)
          }.`,
          'info'
        );
      }
      return newControls;
    });
  };

  return (
    <ErrorBoundary>
      <div className="app-container">
        <div className="alert-container">
          {alerts.map((alert) => (
            <Alert
              key={alert.id}
              message={alert.message}
              type={alert.type}
              onClose={() => removeAlert(alert.id)}
            />
          ))}
        </div>
        {!inRoom ? (
          <div className="join-room">
            <h2>Start or Join a Meeting</h2>
            <input
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="Enter your name"
            />
            <input
              type="text"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              placeholder="Enter meeting ID (optional)"
            />
            <div className="join-buttons">
              <button onClick={joinRoom}>Join Meeting</button>
              <button onClick={createRoom}>Start Meeting</button>
            </div>
          </div>
        ) : (
          <div className="conference-room">
            <header className="top-bar">
              <div className="meeting-info">
                <h2>Meeting: {roomId} {isHost ? '(Host)' : ''}</h2>
                <span>{Object.keys(peers).length + 1} participant(s)</span>
              </div>
              <div className="top-controls">
                <button onClick={() => setShowChat(!showChat)} title={showChat ? 'Hide Chat' : 'Show Chat'}>
                  <i className="fas fa-comment"></i>
                </button>
                <button onClick={() => setShowDebug(!showDebug)} title={showDebug ? 'Hide Debug' : 'Show Debug'}>
                  <i className="fas fa-bug"></i>
                </button>
              </div>
            </header>
            <div className="main-content">
              <div className="video-container">
                <div className="video-gallery">
                  <div className="video-item local-video">
                    <div className="video-wrapper">
                      <video
                        ref={(el) => {
                          userVideoRef.current.camera = el;
                        }}
                        autoPlay
                        muted
                        playsInline
                        className="video-element"
                      />
                      <div className="video-overlay">
                        <span className="video-name">You ({userName}) - Camera</span>
                        <div className="video-status">
                          {isVideoOn ? <i className="fas fa-video"></i> : <i className="fas fa-video-slash"></i>}
                          {isAudioOn ? <i className="fas fa-microphone"></i> : <i className="fas fa-microphone-slash"></i>}
                        </div>
                      </div>
                    </div>
                    {isScreenSharing && (
                      <div className="video-wrapper">
                        <video
                          ref={(el) => {
                            userVideoRef.current.screen = el;
                          }}
                          autoPlay
                          muted
                          playsInline
                          className="video-element"
                        />
                        <div className="video-overlay">
                          <span className="video-name">You ({userName}) - Screen</span>
                          <div className="video-status">
                            <i className="fas fa-desktop"></i>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  
                  {Object.keys(peers).map((userId) => {
                    const status = connectionStatus[userId];
                    const controls = participantControls[userId];
                    
                    return (
                      <div className="video-item" key={userId}>
                        <div className="video-wrapper">
                          <video
                            ref={(el) => {
                              if (el) {
                                peerVideoRefs.current[userId] = { ...peerVideoRefs.current[userId], camera: el };
                                if (pendingRemoteStreams.current[userId]?.camera && !el.srcObject) {
                                  el.srcObject = pendingRemoteStreams.current[userId].camera;
                                  el.play().catch((err) => {
                                    logDebug(`Error playing camera stream for ${userId}: ${err.message}`);
                                    //addAlert(`Failed to play camera stream for ${status?.userName || shortId(userId)}.`, 'error');
                                  });
                                }
                              }
                            }}
                            autoPlay
                            playsInline
                            className="video-element"
                          />
                          <div className="video-overlay">
                            <span className="video-name">
                              {status?.userName || `Participant (${shortId(userId)})`} - Camera
                            </span>
                            <div className="video-status">
                              <span>{status?.status || 'connecting'}</span>
                              {isHost && (
                                <div className="proctor-controls">
                                  <button
                                    onClick={() => toggleParticipantMedia(userId, 'video')}
                                    className={!controls?.video ? 'disabled' : ''}
                                    title={controls?.video ? 'Turn off video' : 'Turn on video'}
                                  >
                                    <i className={controls?.video ? 'fas fa-video' : 'fas fa-video-slash'}></i>
                                  </button>
                                  <button
                                    onClick={() => toggleParticipantMedia(userId, 'audio')}
                                    className={!controls?.audio ? 'disabled' : ''}
                                    title={controls?.audio ? 'Mute' : 'Unmute'}
                                  >
                                    <i className={controls?.audio ? 'fas fa-microphone' : 'fas fa-microphone-slash'}></i>
                                  </button>
                                  <button
                                    onClick={() => toggleParticipantMedia(userId, 'proctor')}
                                    className={controls?.proctor ? 'proctor-enabled' : ''}
                                    title={controls?.proctor ? 'Disable proctor' : 'Enable proctor'}
                                  >
                                    <i className={controls?.proctor ? 'fas fa-user-check' : 'fas fa-user'}></i>
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                        {connectionStatus[userId]?.streams?.screen && (
                          <div className="video-wrapper">
                            <video
                              ref={(el) => {
                                if (el) {
                                  peerVideoRefs.current[userId] = { ...peerVideoRefs.current[userId], screen: el };
                                  if (pendingRemoteStreams.current[userId]?.screen && !el.srcObject) {
                                    el.srcObject = pendingRemoteStreams.current[userId].screen;
                                    el.play().catch((err) => {
                                      logDebug(`Error playing screen stream for ${userId}: ${err.message}`);
                                      addAlert(`Failed to play screen stream for ${status?.userName || shortId(userId)}.`, 'error');
                                    });
                                  }
                                }
                              }}
                              autoPlay
                              playsInline
                              className="video-element"
                            />
                            <div className="video-overlay">
                              <span className="video-name">
                                {status?.userName || `Participant (${shortId(userId)})`} - Screen
                              </span>
                              <div className="video-status">
                                <i className="fas fa-desktop"></i>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className={`side-panel ${showChat ? 'open' : ''}`}>
                <div className="chat-container">
                  <div className="chat-header">
                    <h3>Chat</h3>
                    <button onClick={() => setShowChat(false)} title="Close chat"><i className="fas fa-times"></i></button>
                  </div>
                  <div className="chat-messages" ref={chatRef}>
                    {messages.map((msg, index) => (
                      <div key={index} className={`chat-message ${msg.from === socketRef.current.id ? 'own-message' : ''}`}>
                        <div className="chat-meta">
                          <span className="chat-sender">{msg.from === socketRef.current.id ? 'You' : msg.userName}</span>
                          <span className="chat-time">{msg.time}</span>
                        </div>
                        <div className="chat-text">{msg.message}</div>
                      </div>
                    ))}
                  </div>
                  <div className="chat-input">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder="Type a message..."
                      onKeyPress={(e) => e.key === 'Enter' && sendChatMessage()}
                    />
                    <button onClick={sendChatMessage} title="Send message"><i className="fas fa-paper-plane"></i></button>
                  </div>
                </div>
              </div>
            </div>
            <footer className="bottom-bar">
              <div className="controls">
                <button
                  onClick={toggleVideo}
                  disabled={isHost ? false : !isVideoOn}
                  className={isVideoOn ? '' : 'disabled'}
                  title={isVideoOn ? 'Turn off camera' : 'Turn on camera'}
                >
                  <i className={isVideoOn ? 'fas fa-video' : 'fas fa-video-slash'}></i>
                </button>
                <button
                  onClick={toggleAudio}
                  disabled={isHost ? false : !isAudioOn}
                  className={isAudioOn ? '' : 'disabled'}
                  title={isAudioOn ? 'Mute' : 'Unmute'}
                >
                  <i className={isAudioOn ? 'fas fa-microphone' : 'fas fa-microphone-slash'}></i>
                </button>
                <button
                  onClick={toggleScreenShare}
                  className={isScreenSharing ? 'sharing' : ''}
                  title={isScreenSharing ? 'Stop sharing' : 'Share screen'}
                >
                  <i className={isScreenSharing ? 'fas fa-desktop' : 'fas fa-share-square'}></i>
                </button>
              </div>
            </footer>
            {showDebug && (
              <div className="debug-panel">
                <h4>Debug Log</h4>
                <ul>
                  {debugLog.map((log, index) => (
                    <li key={index}>{log}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <style>
          {`:root {
              --primary-bg: #1a1a2e;
              --secondary-bg: #16213e;
              --accent-blue: #00b7eb;
              --accent-purple: #6b48ff;
              --text-color: #e0e0e0;
              --error: #ff4d4d;
              --success: #00cc69;
              --warning: #ffaa00;
              --info: #00b7eb;
              --border: #2e2e4b;
            }

            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }

            .app-container {
              font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
              height: 100vh;
              display: flex;
              flex-direction: column;
              background: var(--primary-bg);
              color: var(--text-color);
              overflow: hidden;
            }

            .error-message {
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100%;
              font-size: 18px;
              color: var(--error);
            }

            .alert-container {
              position: fixed;
              top: 16px;
              right: 16px;
              z-index: 2000;
              max-width: 320px;
              width: 90%;
            }

            .alert {
              padding: 10px 14px;
              margin-bottom: 8px;
              border-radius: 6px;
              color: var(--text-color);
              display: flex;
              justify-content: space-between;
              align-items: center;
              box-shadow: 0 2px 6px rgba(0,0,0,0.3);
              animation: fadeIn 0.3s ease-in-out;
              font-size: 13px;
              background: var(--secondary-bg);
              border: 1px solid var(--border);
            }

            .alert-error { border-color: var(--error); }
            .alert-success { border-color: var(--success); }
            .alert-info { border-color: var(--info); }
            .alert-warning { border-color: var(--warning); }

            .alert-close {
              background: none;
              border: none;
              color: var(--text-color);
              font-size: 14px;
              cursor: pointer;
              padding: 0 8px;
              opacity: 0.7;
            }

            .alert-close:hover {
              opacity: 1;
            }

            @keyframes fadeIn {
              from { opacity: 0; transform: translateY(-10px); }
              to { opacity: 1; transform: translateY(0); }
            }

            .join-room {
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              height: 100%;
              gap: 16px;
              padding: 24px;
              background: var(--secondary-bg);
              border-radius: 12px;
              box-shadow: 0 4px 20px rgba(0,0,0,0.4);
              max-width: 360px;
              margin: auto;
            }

            .join-room h2 {
              font-size: 22px;
              font-weight: 600;
              margin-bottom: 20px;
              color: var(--text-color);
            }

            .join-room input {
              width: 100%;
              padding: 12px;
              border: 1px solid var(--border);
              border-radius: 6px;
              font-size: 14px;
              background: #24244a;
              color: var(--text-color);
              transition: border-color 0.2s;
            }

            .join-room input:focus {
              border-color: var(--accent-blue);
              outline: none;
            }

            .join-buttons {
              display: flex;
              gap: 12px;
              width: 100%;
            }

            .join-buttons button {
              flex: 1;
              padding: 12px;
              border: none;
              border-radius: 6px;
              cursor: pointer;
              font-size: 14px;
              color: var(--text-color);
              background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
              transition: opacity 0.2s;
            }

            .join-buttons button:hover {
              opacity: 0.9;
            }

            .conference-room {
              display: flex;
              flex-direction: column;
              height: 100%;
            }

            .top-bar {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 12px 20px;
              background: var(--secondary-bg);
              border-bottom: 1px solid var(--border);
            }

            .meeting-info {
              display: flex;
              flex-direction: column;
              gap: 4px;
            }

            .meeting-info h2 {
              font-size: 16px;
              font-weight: 600;
              margin: 0;
            }

            .meeting-info span {
              font-size: 12px;
              color: #a0a0c0;
            }

            .top-controls {
              display: flex;
              gap: 8px;
            }

            .top-controls button {
              padding: 8px;
              background: none;
              border: 1px solid var(--border);
              border-radius: 6px;
              cursor: pointer;
              color: var(--text-color);
              font-size: 14px;
              transition: background-color 0.2s;
            }

            .top-controls button:hover {
              background: #2e2e4b;
            }

            .main-content {
              flex: 1;
              display: flex;
              overflow: hidden;
            }

            .video-container {
              flex: 1;
              padding: 12px;
              background: #000;
              overflow: auto;
            }

            .video-gallery {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
              gap: 12px;
              max-width: 1400px;
              margin: 0 auto;
            }

            .video-item {
              display: flex;
              flex-direction: column;
              gap: 12px;
              background: #1c1c38;
              border-radius: 10px;
              overflow: hidden;
              transition: transform 0.2s;
            }

            .local-video {
              grid-column: span 2;
              max-width: 500px;
              margin: 0 auto;
            }

            .video-item:hover {
              transform: scale(1.02);
            }

            .video-wrapper {
              position: relative;
              width: 100%;
              aspect-ratio: 16 / 9;
            }

            .video-element {
              width: 100%;
              height: 100%;
              object-fit: cover;
            }

            .video-overlay {
              position: absolute;
              bottom: 0;
              left: 0;
              right: 0;
              padding: 8px;
              background: linear-gradient(to top, rgba(0,0,0,0.7), transparent);
              color: var(--text-color);
              display: flex;
              flex-direction: column;
              gap: 4px;
            }

            .video-name {
              font-size: 13px;
              font-weight: 500;
            }

            .video-status {
              font-size: 11px;
              display: flex;
              align-items: center;
              gap: 6px;
            }

            .video-status span {
              color: #a0a0c0;
            }

            .proctor-controls {
              display: flex;
              gap: 4px;
              margin-left: auto;
            }

            .proctor-controls button {
              padding: 6px;
              background: rgba(255,255,255,0.1);
              border: none;
              border-radius: 4px;
              color: var(--text-color);
              cursor: pointer;
              font-size: 12px;
              transition: background-color 0.2s;
            }

            .proctor-controls button:hover {
              background: rgba(255,255,255,0.2);
            }

            .proctor-controls button.disabled {
              background: var(--error);
            }

            .proctor-controls button.proctor-enabled {
              background: var(--success);
            }

            .side-panel {
              width: 300px;
              background: var(--secondary-bg);
              border-left: 1px solid var(--border);
              display: flex;
              flex-direction: column;
              transform: translateX(100%);
              transition: transform 0.3s ease-in-out;
            }

            .side-panel.open {
              transform: translateX(0);
            }

            .chat-container {
              flex: 1;
              display: flex;
              flex-direction: column;
              padding: 12px;
            }

            .chat-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 12px;
            }

            .chat-header h3 {
              font-size: 16px;
              font-weight: 600;
              margin: 0;
            }

            .chat-header button {
              background: none;
              border: none;
              font-size: 14px;
              cursor: pointer;
              color: var(--text-color);
              opacity: 0.7;
            }

            .chat-header button:hover {
              opacity: 1;
            }

            .chat-messages {
              flex: 1;
              overflow-y: auto;
              padding: 8px;
              background: #1c1c38;
              border-radius: 6px;
              margin-bottom: 12px;
            }

            .chat-message {
              margin-bottom: 12px;
              padding: 10px;
              border-radius: 6px;
              background: #24244a;
              max-width: 80%;
            }

            .chat-message.own-message {
              background: var(--accent-blue);
              margin-left: auto;
            }

            .chat-meta {
              display: flex;
              gap: 6px;
              align-items: baseline;
              margin-bottom: 4px;
            }

            .chat-sender {
              font-weight: 500;
              color: var(--accent-purple);
            }

            .chat-time {
              color: #a0a0c0;
              font-size: 0.75em;
            }

            .chat-text {
              font-size: 13px;
            }

            .chat-input {
              display: flex;
              gap: 8px;
            }

            .chat-input input {
              flex: 1;
              padding: 10px;
              border: 1px solid var(--border);
              border-radius: 6px;
              font-size: 13px;
              background: #24244a;
              color: var(--text-color);
            }

            .chat-input input:focus {
              border-color: var(--accent-blue);
              outline: none;
            }

            .chat-input button {
              padding: 10px;
              background: var(--accent-blue);
              color: var(--text-color);
              border: none;
              border-radius: 6px;
              cursor: pointer;
            }

            .chat-input button:hover {
              background: var(--accent-purple);
            }

            .bottom-bar {
              display: flex;
              justify-content: center;
              padding: 10px;
              background: var(--secondary-bg);
              border-top: 1px solid var(--border);
            }

            .controls {
              display: flex;
              gap: 12px;
            }

            .controls button {
              padding: 10px;
              background: none;
              border: 1px solid var(--border);
              border-radius: 6px;
              cursor: pointer;
              color: var(--text-color);
              font-size: 14px;
              transition: background-color 0.2s;
            }

            .controls button:hover {
              background: #2e2e4b;
            }

            .controls button.disabled {
              color: var(--error);
              border-color: var(--error);
            }

            .controls button.sharing {
              color: var(--success);
              border-color: var(--success);
            }

            .debug-panel {
              position: absolute;
              bottom: 60px;
              left: 16px;
              right: 16px;
              max-height: 200px;
              overflow-y: auto;
              background: var(--secondary-bg);
              border: 1px solid var(--border);
              padding: 12px;
              border-radius: 6px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.3);
              z-index: 1000;
            }

            .debug-panel h4 {
              font-size: 14px;
              margin-bottom: 8px;
            }

            .debug-panel ul {
              list-style: none;
              padding: 0;
              margin: 0;
            }

            .debug-panel li {
              font-size: 12px;
              margin-bottom: 4px;
              color: #a0a0c0;
            }

            @media (max-width: 1024px) {
              .main-content {
                flex-direction: column;
              }
              .side-panel {
                width: 100%;
                height: 40%;
                border-left: none;
                border-top: 1px solid var(--border);
                transform: translateY(100%);
              }
              .side-panel.open {
                transform: translateY(0);
              }
              .video-container {
                height: 60%;
              }
              .video-gallery {
                grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
              }
              .local-video {
                grid-column: span 1;
              }
            }

            @media (max-width: 768px) {
              .top-bar {
                flex-direction: column;
                gap: 8px;
                padding: 8px 16px;
              }
              .controls {
                gap: 8px;
              }
              .controls button {
                padding: 8px;
                font-size: 12px;
              }
              .alert-container {
                top: 8px;
                right: 8px;
                max-width: 90%;
              }
              .join-room {
                padding: 16px;
                max-width: 90%;
              }
              .video-gallery {
                grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
              }
            }`}
        </style>
      </div>
    </ErrorBoundary>
  );
};

export default Video;