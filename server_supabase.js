require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const session = require('express-session');
const passport = require('passport');
const TwitterStrategy = require('passport-twitter').Strategy;
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// --- SUPABASE SETUP ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
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
  async function(token, tokenSecret, profile, cb) {
    const user = {
        twitter_id: profile.id,
        username: profile.username,
        display_name: profile.displayName,
        photo_url: profile.photos[0].value,
        profile_url: `https://twitter.com/${profile.username}`
    };

    // Upsert user into Supabase 'users' table
    const { error } = await supabase
        .from('users')
        .upsert(user, { onConflict: 'twitter_id' });

    if (error) console.error('Supabase User Error:', error);

    // Return user object with camelCase for internal app consistency if needed, 
    // or just return the object we created.
    // We'll stick to the object structure we used before for compatibility.
    return cb(null, {
        twitterId: user.twitter_id,
        username: user.username,
        displayName: user.display_name,
        photoUrl: user.photo_url,
        profileUrl: user.profile_url
    });
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
        // Get top 20 high scores with user details
        // We assume a view or a join. Since Supabase is Postgres, we can do a join.
        // Or simpler: select from scores, order by score desc, limit 20.
        // But we need unique users.
        
        // Option 1: Use a Postgres View (Recommended for production)
        // Option 2: JS processing (Fine for small scale)
        
        // Let's try to fetch scores and users.
        const { data, error } = await supabase
            .from('scores')
            .select(`
                score,
                users (username, photo_url, profile_url)
            `)
            .order('score', { ascending: false });

        if (error) throw error;

        // Process in JS to get unique max score per user
        const userMap = new Map();
        data.forEach(entry => {
            const username = entry.users.username;
            if (!userMap.has(username)) {
                userMap.set(username, {
                    username: username,
                    photoUrl: entry.users.photo_url,
                    profileUrl: entry.users.profile_url,
                    highScore: entry.score
                });
            }
        });

        const leaderboard = Array.from(userMap.values()).slice(0, 20);
        res.json(leaderboard);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/score', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { score } = req.body;
    
    try {
        // Insert Score
        const { error } = await supabase
            .from('scores')
            .insert({
                twitter_id: req.user.twitterId,
                score: score
            });

        if (error) throw error;

        // Check Top 3 Logic (Simplified for Supabase)
        // Fetch current top 3
        const { data: allScores } = await supabase
            .from('scores')
            .select(`score, users (username)`)
            .order('score', { ascending: false });
            
        // Deduplicate
        const uniqueScores = [];
        const seen = new Set();
        for(const s of allScores) {
            if(!seen.has(s.users.username)) {
                uniqueScores.push({ username: s.users.username, highScore: s.score });
                seen.add(s.users.username);
            }
        }
        const top3 = uniqueScores.slice(0, 3);

        const rank = top3.findIndex(r => r.username === req.user.username) + 1;
        const userRecord = top3.find(r => r.username === req.user.username);

        if (rank > 0 && rank <= 3 && userRecord && userRecord.highScore === score) {
            const announcement = `👑 @${req.user.username} just took #${rank} place with ${score} points!`;
            
            await supabase.from('messages').insert({
                user_name: 'SYSTEM',
                text: announcement
            });
            
            io.emit('chat message', { user: 'SYSTEM', text: announcement });
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// --- SOCKET.IO ---
io.on('connection', async (socket) => {
    // Load last 50 messages
    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
        
    if (!error && data) {
        data.reverse().forEach(row => {
            socket.emit('chat message', { user: row.user_name, text: row.text });
        });
    }

    socket.on('chat message', async (msg) => {
        // Save to Supabase
        const { error } = await supabase
            .from('messages')
            .insert({
                user_name: msg.user,
                text: msg.text
            });
            
        if(!error) {
            io.emit('chat message', msg);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
