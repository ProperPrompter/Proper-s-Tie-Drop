require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const session = require('express-session');
const passport = require('passport');
const TwitterStrategy = require('passport-twitter').Strategy;
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// --- DATABASE SETUP ---
const db = new sqlite3.Database('./leaderboard.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to the leaderboard database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        twitterId TEXT PRIMARY KEY,
        username TEXT,
        displayName TEXT,
        photoUrl TEXT,
        profileUrl TEXT
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        twitterId TEXT,
        score INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(twitterId) REFERENCES users(twitterId)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT,
        text TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from 'public' folder
app.use(session({
    secret: process.env.SESSION_SECRET || 'keyboard cat',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// --- PASSPORT CONFIG ---
passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((obj, done) => {
    done(null, obj);
});

passport.use(new TwitterStrategy({
    consumerKey: process.env.TWITTER_CONSUMER_KEY,
    consumerSecret: process.env.TWITTER_CONSUMER_SECRET,
    callbackURL: process.env.CALLBACK_URL
  },
  function(token, tokenSecret, profile, cb) {
    // Update or Insert User
    const user = {
        twitterId: profile.id,
        username: profile.username,
        displayName: profile.displayName,
        photoUrl: profile.photos[0].value,
        profileUrl: `https://twitter.com/${profile.username}`
    };

    const stmt = db.prepare("INSERT OR REPLACE INTO users (twitterId, username, displayName, photoUrl, profileUrl) VALUES (?, ?, ?, ?, ?)");
    stmt.run(user.twitterId, user.username, user.displayName, user.photoUrl, user.profileUrl);
    stmt.finalize();

    return cb(null, user);
  }
));

// --- ROUTES ---

// Serve the game file specifically if requested or as root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Auth Routes
app.get('/auth/twitter', passport.authenticate('twitter'));

app.get('/auth/twitter/callback', 
  passport.authenticate('twitter', { failureRedirect: '/' }),
  function(req, res) {
    // Successful authentication, redirect home.
    res.redirect('/');
  });

app.get('/auth/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.redirect('/');
    });
});

// API: Get Current User
app.get('/api/user', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({ authenticated: true, user: req.user });
    } else {
        res.json({ authenticated: false });
    }
});

// API: Get Leaderboard
app.get('/api/leaderboard', (req, res) => {
    const query = `
        SELECT u.username, u.photoUrl, u.profileUrl, MAX(s.score) as highScore
        FROM scores s
        JOIN users u ON s.twitterId = u.twitterId
        GROUP BY u.twitterId
        ORDER BY highScore DESC
        LIMIT 20
    `;
    
    db.all(query, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// API: Submit Score
app.post('/api/score', (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { score } = req.body;
    const stmt = db.prepare("INSERT INTO scores (twitterId, score) VALUES (?, ?)");
    stmt.run(req.user.twitterId, score, function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }

        // Check for Top 3 placement to announce
        const checkQuery = `
            SELECT u.username, MAX(s.score) as highScore
            FROM scores s
            JOIN users u ON s.twitterId = u.twitterId
            GROUP BY u.twitterId
            ORDER BY highScore DESC
            LIMIT 3
        `;
        db.all(checkQuery, [], (err, rows) => {
            if (!err && rows) {
                const rank = rows.findIndex(r => r.username === req.user.username) + 1;
                // Only announce if they are in top 3 AND the score they just submitted matches their high score (meaning it's a new record for them that put them there)
                const userRecord = rows.find(r => r.username === req.user.username);
                
                if (rank > 0 && rank <= 3 && userRecord && userRecord.highScore === score) {
                    const announcement = `👑 @${req.user.username} just took #${rank} place with ${score} points!`;
                    
                    // Save system message
                    const sysStmt = db.prepare("INSERT INTO messages (user, text) VALUES (?, ?)");
                    sysStmt.run('SYSTEM', announcement);
                    sysStmt.finalize();

                    // Broadcast
                    io.emit('chat message', { user: 'SYSTEM', text: announcement });
                }
            }
        });

        res.json({ success: true, id: this.lastID });
    });
    stmt.finalize();
});

// --- SOCKET.IO CHAT ---
io.on('connection', (socket) => {
    // Send last 50 messages to the new user
    db.all("SELECT user, text FROM messages ORDER BY id DESC LIMIT 50", [], (err, rows) => {
        if (err) return console.error(err);
        // Send in reverse order so they appear correctly (oldest first)
        rows.reverse().forEach(row => {
            socket.emit('chat message', { user: row.user, text: row.text });
        });
    });

    socket.on('chat message', (msg) => {
        // msg should be { user: "username", text: "hello" }
        const stmt = db.prepare("INSERT INTO messages (user, text) VALUES (?, ?)");
        stmt.run(msg.user, msg.text);
        stmt.finalize();
        
        io.emit('chat message', msg);
    });
});

app.listen = function() {
    console.warn("Warning: app.listen called instead of server.listen");
    return server.listen.apply(server, arguments);
};

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
