const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Serve index.html from root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Database Setup - Using persistent file database
const dbPath = process.env.NODE_ENV === 'production' ? ':memory:' : './game.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Database connection error:', err);
    } else {
        console.log('Connected to SQLite database');
    }
});

// Initialize database tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error('Error creating users table:', err);
    });
    
    db.run(`CREATE TABLE IF NOT EXISTS user_stats (
        user_id INTEGER PRIMARY KEY,
        games_played INTEGER DEFAULT 0,
        games_won INTEGER DEFAULT 0,
        times_imposter INTEGER DEFAULT 0,
        times_caught_imposter INTEGER DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`, (err) => {
        if (err) console.error('Error creating user_stats table:', err);
    });
});

// Word Libraries
const wordLibraries = {
    animals: {
        name: "Tiere",
        description: "Verschiedene Tierarten aus aller Welt",
        words: {
            easy: ["Hund", "Katze", "Pferd", "Kuh", "Schwein", "Huhn", "Ente", "Schaf", "Ziege", "Hase"],
            medium: ["Elefant", "Giraffe", "Zebra", "Löwe", "Tiger", "Panda", "Koala", "Pinguin", "Delfin", "Wal"],
            hard: ["Axolotl", "Quetzal", "Okapi", "Gharial", "Aye-Aye", "Pangolin", "Tapir", "Binturong", "Fossa", "Numbat"]
        }
    },
    food: {
        name: "Essen & Trinken", 
        description: "Leckere Speisen und Getränke",
        words: {
            easy: ["Apfel", "Brot", "Käse", "Milch", "Wasser", "Reis", "Nudeln", "Ei", "Butter", "Zucker"],
            medium: ["Lasagne", "Sushi", "Cappuccino", "Croissant", "Paella", "Quinoa", "Hummus", "Gazpacho", "Risotto", "Tiramisu"],
            hard: ["Bouillabaisse", "Ceviche", "Maultasche", "Borschtsch", "Kimchi", "Pho", "Mole", "Tagine", "Pierogi", "Baklava"]
        }
    },
    objects: {
        name: "Gegenstände",
        description: "Alltägliche und besondere Gegenstände", 
        words: {
            easy: ["Stuhl", "Tisch", "Buch", "Telefon", "Auto", "Haus", "Fenster", "Tür", "Lampe", "Uhr"],
            medium: ["Computer", "Mikrowelle", "Staubsauger", "Waschmaschine", "Fernseher", "Kühlschrank", "Sofa", "Schrank", "Spiegel", "Bild"],
            hard: ["Kaleidoskop", "Astrolabium", "Sextant", "Chronometer", "Barometer", "Hygrometer", "Seismograph", "Spektrometer", "Theodolite", "Planimeter"]
        }
    },
    activities: {
        name: "Aktivitäten",
        description: "Hobbys, Sport und Freizeitaktivitäten",
        words: {
            easy: ["Laufen", "Schwimmen", "Lesen", "Singen", "Tanzen", "Malen", "Kochen", "Schlafen", "Essen", "Spielen"],
            medium: ["Bergsteigen", "Surfen", "Fotografieren", "Gärtnern", "Angeln", "Wandern", "Radfahren", "Skifahren", "Segeln", "Reiten"],
            hard: ["Falknerei", "Kalligrafie", "Origami", "Bonsai", "Geocaching", "Parkour", "Aikido", "Bogenschießen", "Slacklining", "Kite-Surfen"]
        }
    }
};

// Game State Management
const rooms = new Map();
const users = new Map();
const roomTimers = new Map();

class GameRoom {
    constructor(id, name, adminId) {
        this.id = id;
        this.name = name;
        this.adminId = adminId;
        this.players = [];
        this.gameState = 'waiting'; // waiting, playing, voting, ended
        this.settings = {
            maxPlayers: 10,
            roundTime: 300, // 5 minutes
            theme: 'animals',
            difficulty: 'medium'
        };
        this.currentRound = {
            word: null,
            imposter: null,
            timeRemaining: 0,
            skipVotes: new Set(),
            votes: new Map(),
            startTime: null
        };
        this.gameHistory = [];
    }
    
    addPlayer(player) {
        if (this.players.length >= this.settings.maxPlayers) {
            return false;
        }
        
        // Check if player is already in room
        if (this.players.find(p => p.id === player.id)) {
            return false;
        }
        
        // First player becomes admin
        if (this.players.length === 0) {
            player.isAdmin = true;
            this.adminId = player.id;
        }
        
        this.players.push(player);
        return true;
    }
    
    removePlayer(playerId) {
        this.players = this.players.filter(p => p.id !== playerId);
        
        // If admin left, make next player admin
        if (this.adminId === playerId && this.players.length > 0) {
            this.players[0].isAdmin = true;
            this.adminId = this.players[0].id;
        }
        
        return this.players.length === 0; // Return true if room is empty
    }
    
    startGame() {
        if (this.players.length < 3) return false;
        if (this.gameState !== 'waiting') return false;
        
        this.gameState = 'playing';
        
        // Select random imposter
        const imposterIndex = Math.floor(Math.random() * this.players.length);
        this.currentRound.imposter = this.players[imposterIndex];
        
        // Select random word
        const words = wordLibraries[this.settings.theme].words[this.settings.difficulty];
        this.currentRound.word = words[Math.floor(Math.random() * words.length)];
        
        // Reset round data
        this.currentRound.timeRemaining = this.settings.roundTime;
        this.currentRound.skipVotes.clear();
        this.currentRound.votes.clear();
        this.currentRound.startTime = Date.now();
        
        return true;
    }
    
    addSkipVote(playerId) {
        this.currentRound.skipVotes.add(playerId);
        const needed = Math.ceil(this.players.length / 2);
        
        if (this.currentRound.skipVotes.size >= needed) {
            this.endRound();
            return true;
        }
        return false;
    }
    
    addVote(voterId, targetId) {
        this.currentRound.votes.set(voterId, targetId);
        
        if (this.currentRound.votes.size === this.players.length) {
            return this.endGame();
        }
        return null;
    }
    
    endRound() {
        this.gameState = 'voting';
        this.currentRound.timeRemaining = 60; // 1 minute for voting
    }
    
    endGame() {
        this.gameState = 'ended';
        
        // Count votes
        const voteCount = new Map();
        this.currentRound.votes.forEach(targetId => {
            voteCount.set(targetId, (voteCount.get(targetId) || 0) + 1);
        });
        
        // Find most voted player
        let mostVoted = null;
        let maxVotes = 0;
        
        voteCount.forEach((votes, playerId) => {
            if (votes > maxVotes) {
                maxVotes = votes;
                mostVoted = this.players.find(p => p.id === playerId);
            }
        });
        
        const imposterWon = !mostVoted || mostVoted.id !== this.currentRound.imposter.id;
        
        this.gameHistory.push({
            word: this.currentRound.word,
            imposter: this.currentRound.imposter,
            votedOut: mostVoted,
            imposterWon: imposterWon,
            players: [...this.players],
            timestamp: new Date()
        });
        
        // Update player stats
        this.updatePlayerStats(imposterWon, mostVoted);
        
        return {
            word: this.currentRound.word,
            imposter: this.currentRound.imposter,
            votedOut: mostVoted,
            imposterWon: imposterWon
        };
    }
    
    updatePlayerStats(imposterWon, votedOut) {
        this.players.forEach(player => {
            const isImposter = player.id === this.currentRound.imposter.id;
            const won = isImposter ? imposterWon : !imposterWon;
            
            // Update database
            db.get('SELECT * FROM user_stats WHERE user_id = ?', [player.id], (err, row) => {
                if (err) {
                    console.error('Database error:', err);
                    return;
                }
                
                if (!row) {
                    db.run('INSERT INTO user_stats (user_id, games_played, games_won, times_imposter, times_caught_imposter) VALUES (?, 1, ?, ?, ?)', 
                        [player.id, won ? 1 : 0, isImposter ? 1 : 0, (isImposter && votedOut && votedOut.id === player.id) ? 1 : 0]);
                } else {
                    const newStats = {
                        games_played: row.games_played + 1,
                        games_won: row.games_won + (won ? 1 : 0),
                        times_imposter: row.times_imposter + (isImposter ? 1 : 0),
                        times_caught_imposter: row.times_caught_imposter + (isImposter && votedOut && votedOut.id === player.id ? 1 : 0)
                    };
                    
                    db.run(`UPDATE user_stats SET 
                        games_played = ?, games_won = ?, times_imposter = ?, times_caught_imposter = ?
                        WHERE user_id = ?`, 
                        [newStats.games_played, newStats.games_won, newStats.times_imposter, newStats.times_caught_imposter, player.id]
                    );
                }
            });
        });
    }
    
    resetGame() {
        this.gameState = 'waiting';
        this.currentRound = {
            word: null,
            imposter: null,
            timeRemaining: 0,
            skipVotes: new Set(),
            votes: new Map(),
            startTime: null
        };
    }
    
    toJSON() {
        return {
            id: this.id,
            name: this.name,
            players: this.players,
            gameState: this.gameState,
            settings: this.settings,
            currentRound: {
                timeRemaining: this.currentRound.timeRemaining,
                skipVotes: this.currentRound.skipVotes.size,
                skipNeeded: Math.ceil(this.players.length / 2)
            }
        };
    }
}

// API Routes
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Username und Passwort sind erforderlich' });
        }
        
        if (username.length < 3) {
            return res.status(400).json({ error: 'Benutzername muss mindestens 3 Zeichen lang sein' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen lang sein' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        db.run('INSERT INTO users (username, password) VALUES (?, ?)', 
            [username, hashedPassword], 
            function(err) {
                if (err) {
                    console.error('Database error:', err);
                    if (err.message.includes('UNIQUE constraint failed')) {
                        return res.status(400).json({ error: 'Benutzername bereits vergeben' });
                    }
                    return res.status(500).json({ error: 'Serverfehler' });
                }
                
                const token = jwt.sign({ id: this.lastID, username }, JWT_SECRET, { expiresIn: '7d' });
                
                // Create initial stats
                db.run('INSERT INTO user_stats (user_id) VALUES (?)', [this.lastID], (err) => {
                    if (err) console.error('Stats creation error:', err);
                });
                
                res.json({
                    token,
                    user: { id: this.lastID, username }
                });
            }
        );
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Serverfehler' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Username und Passwort sind erforderlich' });
        }
        
        db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Serverfehler' });
            }
            
            if (!user) {
                return res.status(400).json({ error: 'Ungültige Anmeldedaten' });
            }
            
            try {
                const validPassword = await bcrypt.compare(password, user.password);
                if (!validPassword) {
                    return res.status(400).json({ error: 'Ungültige Anmeldedaten' });
                }
                
                const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
                
                res.json({
                    token,
                    user: { id: user.id, username: user.username }
                });
            } catch (bcryptError) {
                console.error('Bcrypt error:', bcryptError);
                return res.status(500).json({ error: 'Serverfehler' });
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Serverfehler' });
    }
});

app.get('/api/libraries', (req, res) => {
    res.json(wordLibraries);
});

app.get('/api/stats/:userId', (req, res) => {
    const userId = parseInt(req.params.userId);
    
    if (isNaN(userId)) {
        return res.status(400).json({ error: 'Ungültige Benutzer-ID' });
    }
    
    db.get('SELECT * FROM user_stats WHERE user_id = ?', [userId], (err, stats) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Serverfehler' });
        }
        
        if (!stats) {
            stats = { games_played: 0, games_won: 0, times_imposter: 0, times_caught_imposter: 0 };
        }
        
        const winRate = stats.games_played > 0 ? Math.round((stats.games_won / stats.games_played) * 100) : 0;
        const imposterSuccessRate = stats.times_imposter > 0 ? 
            Math.round(((stats.times_imposter - stats.times_caught_imposter) / stats.times_imposter) * 100) : 0;
        
        res.json({
            stats: {
                gamesPlayed: stats.games_played,
                gamesWon: stats.games_won,
                winRate: winRate,
                timesImposter: stats.times_imposter,
                timesCaughtImposter: stats.times_caught_imposter,
                imposterSuccessRate: imposterSuccessRate
            }
        });
    });
});

// Socket.io Events
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('authenticate', (token) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            socket.userId = decoded.id;
            socket.username = decoded.username;
            
            users.set(socket.id, {
                id: decoded.id,
                username: decoded.username,
                socketId: socket.id
            });
            
            socket.emit('authenticated', { id: decoded.id, username: decoded.username });
        } catch (error) {
            console.error('JWT verification error:', error);
            socket.emit('authError', 'Token ungültig');
        }
    });
    
    socket.on('createRoom', (roomName) => {
        if (!socket.userId) {
            socket.emit('error', 'Nicht authentifiziert');
            return;
        }
        
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const room = new GameRoom(roomId, roomName, socket.userId);
        
        const player = {
            id: socket.userId,
            username: socket.username,
            socketId: socket.id,
            isAdmin: true
        };
        
        room.addPlayer(player);
        rooms.set(roomId, room);
        
        socket.join(roomId);
        socket.roomId = roomId;
        
        socket.emit('roomCreated', { roomId });
        socket.emit('roomUpdate', room.toJSON());
        
        console.log(`Room ${roomId} created by ${socket.username}`);
    });
    
    socket.on('joinRoom', (roomId) => {
        if (!socket.userId) {
            socket.emit('error', 'Nicht authentifiziert');
            return;
        }
        
        const room = rooms.get(roomId);
        if (!room) {
            socket.emit('error', 'Raum nicht gefunden');
            return;
        }
        
        if (room.gameState !== 'waiting') {
            socket.emit('error', 'Spiel läuft bereits');
            return;
        }
        
        const player = {
            id: socket.userId,
            username: socket.username,
            socketId: socket.id,
            isAdmin: false
        };
        
        if (!room.addPlayer(player)) {
            socket.emit('error', 'Raum ist voll oder du bist bereits im Raum');
            return;
        }
        
        socket.join(roomId);
        socket.roomId = roomId;
        
        socket.emit('roomJoined', { roomId });
        io.to(roomId).emit('roomUpdate', room.toJSON());
        
        // Send welcome message
        io.to(roomId).emit('chatMessage', {
            sender: 'System',
            message: `${socket.username} ist dem Raum beigetreten`,
            timestamp: new Date().toLocaleTimeString(),
            type: 'system'
        });
        
        console.log(`${socket.username} joined room ${roomId}`);
    });
    
    socket.on('leaveRoom', (roomId) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        socket.leave(roomId);
        
        // Clear any existing timer
        if (roomTimers.has(roomId)) {
            clearInterval(roomTimers.get(roomId));
            roomTimers.delete(roomId);
        }
        
        if (room.removePlayer(socket.userId)) {
            // Room is empty, delete it
            rooms.delete(roomId);
            console.log(`Room ${roomId} deleted (empty)`);
        } else {
            io.to(roomId).emit('roomUpdate', room.toJSON());
            io.to(roomId).emit('chatMessage', {
                sender: 'System',
                message: `${socket.username} hat den Raum verlassen`,
                timestamp: new Date().toLocaleTimeString(),
                type: 'system'
            });
        }
        
        socket.roomId = null;
        console.log(`${socket.username} left room ${roomId}`);
    });
    
    socket.on('updateSettings', ({ roomId, settings }) => {
        const room = rooms.get(roomId);
        if (!room || room.adminId !== socket.userId) {
            socket.emit('error', 'Keine Berechtigung');
            return;
        }
        
        room.settings = { ...room.settings, ...settings };
        io.to(roomId).emit('roomUpdate', room.toJSON());
    });
    
    socket.on('startGame', (roomId) => {
        const room = rooms.get(roomId);
        if (!room || room.adminId !== socket.userId) {
            socket.emit('error', 'Keine Berechtigung');
            return;
        }
        
        if (!room.startGame()) {
            socket.emit('error', 'Spiel kann nicht gestartet werden (mindestens 3 Spieler benötigt)');
            return;
        }
        
        // Send game start data to each player
        room.players.forEach(player => {
            const playerSocket = [...io.sockets.sockets.values()]
                .find(s => s.userId === player.id);
            
            if (playerSocket) {
                playerSocket.emit('gameStarted', {
                    word: player.id === room.currentRound.imposter.id ? null : room.currentRound.word,
                    isImposter: player.id === room.currentRound.imposter.id,
                    timeLimit: room.settings.roundTime
                });
            }
        });
        
        io.to(roomId).emit('roomUpdate', room.toJSON());
        
        // Start round timer
        const timer = setInterval(() => {
            room.currentRound.timeRemaining--;
            
            if (room.currentRound.timeRemaining <= 0) {
                clearInterval(timer);
                roomTimers.delete(roomId);
                room.endRound();
                io.to(roomId).emit('votingPhase', { 
                    players: room.players
                });
                io.to(roomId).emit('roomUpdate', room.toJSON());
            }
        }, 1000);
        
        roomTimers.set(roomId, timer);
        console.log(`Game started in room ${roomId}, imposter: ${room.currentRound.imposter.username}`);
    });
    
    socket.on('skipVote', (roomId) => {
        const room = rooms.get(roomId);
        if (!room || room.gameState !== 'playing') return;
        
        if (room.addSkipVote(socket.userId)) {
            // Clear the game timer
            if (roomTimers.has(roomId)) {
                clearInterval(roomTimers.get(roomId));
                roomTimers.delete(roomId);
            }
            
            io.to(roomId).emit('votingPhase', { 
                players: room.players
            });
        }
        
        io.to(roomId).emit('roomUpdate', room.toJSON());
    });
    
    socket.on('vote', ({ roomId, playerId }) => {
        const room = rooms.get(roomId);
        if (!room || room.gameState !== 'voting') return;
        
        const results = room.addVote(socket.userId, playerId);
        
        if (results) {
            io.to(roomId).emit('gameEnded', results);
            
            setTimeout(() => {
                room.resetGame();
                io.to(roomId).emit('roomUpdate', room.toJSON());
            }, 10000);
        }
    });
    
    socket.on('sendMessage', ({ roomId, message }) => {
        const room = rooms.get(roomId);
        if (!room || !socket.username) return;
        
        if (message.trim().length > 0 && message.trim().length <= 500) {
            io.to(roomId).emit('chatMessage', {
                sender: socket.username,
                message: message.trim(),
                timestamp: new Date().toLocaleTimeString(),
                type: 'user'
            });
        }
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        users.delete(socket.id);
        
        if (socket.roomId) {
            const room = rooms.get(socket.roomId);
            if (room) {
                // Clear any existing timer
                if (roomTimers.has(socket.roomId)) {
                    clearInterval(roomTimers.get(socket.roomId));
                    roomTimers.delete(socket.roomId);
                }
                
                if (room.removePlayer(socket.userId)) {
                    rooms.delete(socket.roomId);
                    console.log(`Room ${socket.roomId} deleted (empty after disconnect)`);
                } else {
                    io.to(socket.roomId).emit('roomUpdate', room.toJSON());
                    if (socket.username) {
                        io.to(socket.roomId).emit('chatMessage', {
                            sender: 'System',
                            message: `${socket.username} hat die Verbindung verloren`,
                            timestamp: new Date().toLocaleTimeString(),
                            type: 'system'
                        });
                    }
                }
            }
        }
    });
});

// Error handling
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        db.close();
        process.exit(0);
    });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT}`);
    console.log(`Öffne http://localhost:${PORT} zum Spielen`);
});
