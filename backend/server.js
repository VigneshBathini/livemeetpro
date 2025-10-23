const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Serve static files from the React frontend build folder
app.use(express.static(path.join(__dirname, '..', 'frontend', 'build')));

// CORS config
app.use(cors({
  origin: ['https://livemeet-ribm.onrender.com', 'http://localhost:3000'],
  methods: ['GET', 'POST'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const io = new Server(server, {
  cors: {
    origin: ['https://livemeet-ribm.onrender.com', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
  }
});


const roomHosts = {};

app.get('/test', (req, res) => res.send('Server is running'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'build', 'index.html'));
});

io.on('connection', (socket) => {
  console.log('New user connected:', socket.id);

  socket.on('join-room', (roomId, userId, userName, isHost) => {
    socket.join(roomId);
    if (isHost) {
      roomHosts[roomId] = socket.id; 
      console.log(`Host ${userId || socket.id} (${userName}) joined room ${roomId}`);
    } else {
      console.log(`Participant ${userId || socket.id} (${userName}) joined room ${roomId}`);
    }
    socket.to(roomId).emit('user-joined', userId || socket.id, userName, isHost);
    
    io.in(roomId).allSockets().then(sockets => {
      console.log(`Users in room ${roomId}: ${[...sockets].join(', ')}`);
    });
  });

  socket.on('offer', (data) => {
    socket.to(data.to).emit('offer', { signal: data.signal, from: socket.id });
  });

  socket.on('answer', (data) => {
    socket.to(data.to).emit('answer', { signal: data.signal, from: socket.id });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.to).emit('ice-candidate', { candidate: data.candidate, from: socket.id });
  });

  socket.on('chat-message', (data) => {
    console.log(`Chat message from ${socket.id} (${data.userName}) in room ${data.roomId}: ${data.message}`);
    socket.to(data.roomId).emit('chat-message', {
      message: data.message,
      from: socket.id,
      userName: data.userName
    });
  });

  socket.on('toggle-media', (data) => {
    console.log(`Toggle media for ${data.userId} in room ${data.roomId}: video=${data.video}, audio=${data.audio}`);
    socket.to(data.roomId).to(data.userId).emit('toggle-media', {
      userId: data.userId,
      video: data.video,
      audio: data.audio
    });
  });

  socket.on('toggle-proctor', (data) => {
    console.log(`Toggle proctor for ${data.userId} in room ${data.roomId}: proctor=${data.proctor}`);
    socket.to(data.roomId).to(data.userId).emit('toggle-proctor', {
      userId: data.userId,
      proctor: data.proctor
    });
  });

  socket.on('face-detection-alert', (data) => {
    console.log(`Face detection alert for ${data.userId} in room ${data.roomId}: ${data.message}`);
    socket.to(data.roomId).to(data.userId).emit('face-detection-alert', {
      userId: data.userId,
      message: data.message
    });
  });

  socket.on('tab-switch-alert', (data) => {
    console.log(`Tab switch alert from ${data.userId} (${data.userName}) in room ${data.roomId}: ${data.message}`);

    if (roomHosts[data.roomId]) {
      socket.to(roomHosts[data.roomId]).emit('tab-switch-alert', {
        userId: data.userId,
        userName: data.userName,
        message: data.message
      });
    }
  });

  socket.on('screen-share-status', (data) => {
    console.log(`Screen share status from ${socket.id} (${data.userName}) in room ${data.roomId}: ${data.isScreenSharing}`);
    socket.to(data.roomId).emit('screen-share-status', {
      userId: socket.id,
      userName: data.userName,
      isScreenSharing: data.isScreenSharing,
    });
  });

  socket.on('disconnect', () => {
    socket.broadcast.emit('user-left', socket.id);
    
    for (const roomId in roomHosts) {
      if (roomHosts[roomId] === socket.id) {
        delete roomHosts[roomId];
      }
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT =  5200;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});