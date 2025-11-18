require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const session = require('express-session');
const passport = require('passport');
const TwitterStrategy = require('passport-twitter').Strategy;
const path = require('path');
const { MongoClient } = require('mongodb');
const MongoStore = require('connect-mongo');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// --- MONGODB SETUP ---
const client = new MongoClient(process.env.MONGO_URI);
let db;

async function connectDB() {
    try {
        await client.connect();
        db = client.db('tiedrop');
        console.log('Connected to MongoDB');
    } catch (err) {
        console.error('MongoDB connection error:', err);
    }
}
connectDB();

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET || 'keyboard cat',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }) // Persist sessions
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
  async function(token, tokenSecret, profile, cb) {
    const users = db.collection('users');
    const user = {
        twitterId: profile.id,
        username: profile.username,
        displayName: profile.displayName,
        photoUrl: profile.photos[0].value,
        profileUrl: `https://twitter.com/${profile.username}`
    };
    
    await users.updateOne(
        { twitterId: user.twitterId },
        { $set: user },
        { upsert: true }
    );
    return cb(null, user);
  }
));

// --- ROUTES ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/auth/twitter', passport.authenticate('twitter'));

app.get('/auth/twitter/callback', 
  passport.authenticate('twitter', { failureRedirect: '/' }),
  function(req, res) {
    res.redirect('/');
  });

app.get('/auth/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.redirect('/');
    });
});

app.get('/api/user', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({ authenticated: true, user: req.user });
    } else {
        res.json({ authenticated: false });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const scores = db.collection('scores');
        // Aggregation pipeline to get max score per user and join with user details
        const leaderboard = await scores.aggregate([
            { $sort: { score: -1 } },
            { $group: {
                _id: "$twitterId",
                highScore: { $max: "$score" }
            }},
            { $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "twitterId",
                as: "userDetails"
            }},
            { $unwind: "$userDetails" },
            { $project: {
                username: "$userDetails.username",
                photoUrl: "$userDetails.photoUrl",
                profileUrl: "$userDetails.profileUrl",
                highScore: 1
            }},
            { $sort: { highScore: -1 } },
            { $limit: 20 }
        ]).toArray();
        
        res.json(leaderboard);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/score', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { score } = req.body;
    const scores = db.collection('scores');
    const messages = db.collection('messages');
    
    try {
        await scores.insertOne({
            twitterId: req.user.twitterId,
            score: score,
            timestamp: new Date()
        });

        // Check Top 3
        const top3 = await scores.aggregate([
            { $sort: { score: -1 } },
            { $group: { _id: "$twitterId", highScore: { $max: "$score" } } },
            { $lookup: { from: "users", localField: "_id", foreignField: "twitterId", as: "u" } },
            { $unwind: "$u" },
            { $sort: { highScore: -1 } },
            { $limit: 3 }
        ]).toArray();

        const rank = top3.findIndex(r => r.u.username === req.user.username) + 1;
        const userRecord = top3.find(r => r.u.username === req.user.username);

        if (rank > 0 && rank <= 3 && userRecord && userRecord.highScore === score) {
            const announcement = `👑 @${req.user.username} just took #${rank} place with ${score} points!`;
            await messages.insertOne({ user: 'SYSTEM', text: announcement, timestamp: new Date() });
            io.emit('chat message', { user: 'SYSTEM', text: announcement });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    if(db) {
        db.collection('messages').find().sort({ _id: -1 }).limit(50).toArray().then(rows => {
            rows.reverse().forEach(row => {
                socket.emit('chat message', { user: row.user, text: row.text });
            });
        });
    }

    socket.on('chat message', async (msg) => {
        if(db) {
            await db.collection('messages').insertOne({
                user: msg.user,
                text: msg.text,
                timestamp: new Date()
            });
            io.emit('chat message', msg);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
