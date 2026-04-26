import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import Database from "better-sqlite3";
import Stripe from "stripe";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("database.db");

// Stripe configuration - using environment variable
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_your_secret_key", {
  apiVersion: "2025-12-02.acacia"
});

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS platforms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    url TEXT,
    category TEXT,
    recommended INTEGER DEFAULT 0,
    paymentMethods TEXT,
    rating REAL DEFAULT 5,
    difficulty TEXT DEFAULT 'Fácil',
    payout TEXT,
    minWithdrawal TEXT,
    premiumOnly INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS user_stats (
    userId TEXT PRIMARY KEY,
    dailyGoal REAL DEFAULT 15.00,
    currentEarnings REAL DEFAULT 0.00,
    lastReset TEXT,
    points INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    badges TEXT DEFAULT '[]',
    visitedPlatforms TEXT DEFAULT '[]',
    isPremium INTEGER DEFAULT 0,
    subscriptionType TEXT
  );

  CREATE TABLE IF NOT EXISTS earnings_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT,
    amount REAL,
    timestamp TEXT,
    platformId TEXT
  );
`);

const DATA_FILE = path.join(__dirname, "src", "data", "platforms.json");

// Migration from JSON to SQLite
async function migrateData() {
  try {
    const rowCount = db.prepare("SELECT COUNT(*) as count FROM platforms").get() as { count: number };
    console.log(`Current platform count in DB: ${rowCount.count}`);

    // Check if payout column exists (for existing databases)
    const tableInfo = db.prepare("PRAGMA table_info(platforms)").all() as any[];
    const hasPayout = tableInfo.some(col => col.name === 'payout');

    if (!hasPayout) {
      console.log("Adding missing columns to platforms table...");
      db.exec("ALTER TABLE platforms ADD COLUMN payout TEXT");
      db.exec("ALTER TABLE platforms ADD COLUMN minWithdrawal TEXT");
    }

    const hasPremiumOnly = tableInfo.some(col => col.name === 'premiumOnly');
    if (!hasPremiumOnly) {
      console.log("Adding premiumOnly column to platforms table...");
      db.exec("ALTER TABLE platforms ADD COLUMN premiumOnly INTEGER DEFAULT 0");
    }

    // Add isPremium and subscriptionType to user_stats if not exists
    const userStatsInfo = db.prepare("PRAGMA table_info(user_stats)").all() as any[];
    const hasIsPremium = userStatsInfo.some(col => col.name === 'isPremium');
    if (!hasIsPremium) {
      console.log("Adding isPremium column to user_stats table...");
      db.exec("ALTER TABLE user_stats ADD COLUMN isPremium INTEGER DEFAULT 0");
    }

    const hasSubscriptionType = userStatsInfo.some(col => col.name === 'subscriptionType');
    if (!hasSubscriptionType) {
      console.log("Adding subscriptionType column to user_stats table...");
      db.exec("ALTER TABLE user_stats ADD COLUMN subscriptionType TEXT DEFAULT NULL");
    }

    const data = await fs.readFile(DATA_FILE, "utf-8");
    const platforms = JSON.parse(data);
    console.log(`Found ${platforms.length} platforms in JSON.`);

    if (rowCount.count !== platforms.length || !hasPayout || !hasPremiumOnly) {
      console.log("Syncing platforms from JSON to SQLite...");

      const insert = db.prepare(`
        INSERT INTO platforms (id, name, description, url, category, recommended, paymentMethods, rating, difficulty, payout, minWithdrawal, premiumOnly)
        VALUES (@id, @name, @description, @url, @category, @recommended, @paymentMethods, @rating, @difficulty, @payout, @minWithdrawal, @premiumOnly)
        ON CONFLICT(id) DO UPDATE SET
          payout = excluded.payout,
          minWithdrawal = excluded.minWithdrawal,
          premiumOnly = excluded.premiumOnly
      `);

      const insertMany = db.transaction((items) => {
        for (const item of items) {
          try {
            insert.run({
              id: item.id,
              name: item.name,
              description: item.description || "",
              url: item.url || "",
              category: item.category || "General",
              recommended: item.recommended ? 1 : 0,
              paymentMethods: JSON.stringify(item.paymentMethods || []),
              rating: item.rating || 5,
              difficulty: item.difficulty || "Fácil",
              payout: item.payout || "Medio",
              minWithdrawal: item.minWithdrawal || "N/A",
              premiumOnly: item.premiumOnly ? 1 : 0
            });
          } catch (err) {
            console.error(`Failed to insert platform ${item.id}:`, err);
          }
        }
      });

      insertMany(platforms);
      console.log("Migration complete.");
    }
  } catch (error) {
    console.error("Migration failed or file not found:", error);
  }
}

async function startServer() {
  await migrateData();

  const app = express();
  const PORT = 5173;

  app.use(express.json());

  // Stripe Webhook Handler
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"] as string;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test_webhook_secret";

    try {
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        webhookSecret
      );

      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const userId = session.metadata?.userId;
          const subscriptionType = session.metadata?.subscriptionType || "monthly";

          if (userId) {
            // Activate premium status
            const update = db.prepare(`
              UPDATE user_stats
              SET isPremium = 1,
                  subscriptionType = ?,
                  points = points + 100,
                  badges = CASE
                    WHEN badges LIKE '%"Premium"%' THEN badges
                    ELSE json_insert(badges, '$[#]', 'Premium')
                  END
              WHERE userId = ?
            `);
            update.run(subscriptionType, userId);

            // Insert into earnings_history if amount paid
            if (session.amount_total) {
              const earningsInsert = db.prepare(`
                INSERT INTO earnings_history (userId, amount, timestamp, platformId)
                VALUES (?, ?, ?, ?)
              `);
              earningsInsert.run(
                userId,
                session.amount_total / 100, // Convert from cents to dollars
                new Date().toISOString(),
                `stripe_${subscriptionType}`
              );
            }

            console.log(`Premium activated for user ${userId} via ${subscriptionType}`);
          }
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const userId = subscription.metadata?.userId;

          if (userId) {
            // Deactivate premium status
            const update = db.prepare(`
              UPDATE user_stats
              SET isPremium = 0,
                  subscriptionType = NULL
              WHERE userId = ?
            `);
            update.run(userId);
            console.log(`Premium deactivated for user ${userId}`);
          }
          break;
        }

        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("Webhook error:", err);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  });

  // API Route to get all platforms
  app.get("/api/platforms", (req, res) => {
    try {
      const platforms = db.prepare("SELECT * FROM platforms").all().map((p: any) => ({
        ...p,
        recommended: !!p.recommended,
        premiumOnly: !!p.premiumOnly,
        paymentMethods: JSON.parse(p.paymentMethods || "[]")
      }));
      res.json(platforms);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch platforms" });
    }
  });

  // API Route to save/update a platform
  app.post("/api/platforms", (req, res) => {
    try {
      const platforms = req.body;
      if (!Array.isArray(platforms)) {
        return res.status(400).json({ error: "Invalid data format" });
      }

      const deleteStmt = db.prepare("DELETE FROM platforms");
      const insertStmt = db.prepare(`
        INSERT INTO platforms (id, name, description, url, category, recommended, paymentMethods, rating, difficulty, payout, minWithdrawal, premiumOnly)
        VALUES (@id, @name, @description, @url, @category, @recommended, @paymentMethods, @rating, @difficulty, @payout, @minWithdrawal, @premiumOnly)
      `);

      const syncTransaction = db.transaction((items) => {
        deleteStmt.run();
        for (const item of items) {
          insertStmt.run({
            ...item,
            recommended: item.recommended ? 1 : 0,
            premiumOnly: item.premiumOnly ? 1 : 0,
            paymentMethods: JSON.stringify(item.paymentMethods)
          });
        }
      });

      syncTransaction(platforms);
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to sync platforms" });
    }
  });

  // User Stats Routes
  app.get("/api/user-stats/:userId", (req, res) => {
    const { userId } = req.params;
    let stats = db.prepare("SELECT * FROM user_stats WHERE userId = ?").get(userId) as any;

    if (!stats) {
      stats = {
        userId,
        dailyGoal: 15.00,
        currentEarnings: 0.00,
        lastReset: new Date().toISOString(),
        points: 0,
        level: 1,
        badges: '[]',
        visitedPlatforms: '[]',
        isPremium: 0,
        subscriptionType: null
      };
      db.prepare(`
        INSERT INTO user_stats (userId, dailyGoal, currentEarnings, lastReset, points, level, badges, visitedPlatforms, isPremium, subscriptionType)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
      `).run(
        userId,
        stats.dailyGoal,
        stats.currentEarnings,
        stats.lastReset,
        stats.points,
        stats.level,
        stats.badges,
        stats.visitedPlatforms
      );
    }

    res.json({
      ...stats,
      badges: JSON.parse(stats.badges || '[]'),
      visitedPlatforms: JSON.parse(stats.visitedPlatforms || '[]'),
      isPremium: !!stats.isPremium,
      subscriptionType: stats.subscriptionType
    });
  });

  // Premium Status Endpoint
  app.get("/api/premium-status/:userId", (req, res) => {
    const { userId } = req.params;
    try {
      const stats = db.prepare("SELECT isPremium, subscriptionType FROM user_stats WHERE userId = ?").get(userId) as any;

      if (!stats) {
        return res.json({ isPremium: false, subscriptionType: null });
      }

      res.json({
        isPremium: !!stats.isPremium,
        subscriptionType: stats.subscriptionType
      });
    } catch (error) {
      console.error("Error fetching premium status:", error);
      res.status(500).json({ error: "Failed to fetch premium status" });
    }
  });

  app.post("/api/user-stats/:userId", (req, res) => {
    const { userId } = req.params;
    const { dailyGoal, currentEarnings, points, level, badges, visitedPlatforms, isPremium, subscriptionType } = req.body;

    db.prepare(`
      INSERT INTO user_stats (userId, dailyGoal, currentEarnings, lastReset, points, level, badges, visitedPlatforms, isPremium, subscriptionType)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(userId) DO UPDATE SET
        dailyGoal = COALESCE(excluded.dailyGoal, dailyGoal),
        currentEarnings = COALESCE(excluded.currentEarnings, currentEarnings),
        points = COALESCE(excluded.points, points),
        level = COALESCE(excluded.level, level),
        badges = COALESCE(excluded.badges, badges),
        visitedPlatforms = COALESCE(excluded.visitedPlatforms, visitedPlatforms),
        isPremium = COALESCE(excluded.isPremium, isPremium),
        subscriptionType = COALESCE(excluded.subscriptionType, subscriptionType)
    `).run(
      userId,
      dailyGoal,
      currentEarnings,
      new Date().toISOString(),
      points,
      level,
      JSON.stringify(badges || []),
      JSON.stringify(visitedPlatforms || []),
      isPremium ? 1 : 0,
      subscriptionType
    );

    res.json({ success: true });
  });

  // Gamification Action Route
  app.post("/api/user-action", (req, res) => {
    const { userId, action, platformId } = req.body;

    try {
      const stats = db.prepare("SELECT * FROM user_stats WHERE userId = ?").get(userId) as any;
      if (!stats) return res.status(404).json({ error: "User not found" });

      let pointsToAdd = 0;
      let newBadges: string[] = JSON.parse(stats.badges || '[]');
      let visitedPlatforms: string[] = JSON.parse(stats.visitedPlatforms || '[]');
      let badgeEarned = null;

      if (action === 'visit_platform') {
        pointsToAdd = 10;
        if (platformId && !visitedPlatforms.includes(platformId)) {
          visitedPlatforms.push(platformId);
          if (visitedPlatforms.length >= 10 && !newBadges.includes('Explorador Top 10')) {
            newBadges.push('Explorador Top 10');
            badgeEarned = 'Explorador Top 10';
          }
        }
      } else if (action === 'complete_survey') {
        pointsToAdd = 50;
      } else if (action === 'first_withdrawal') {
        if (!newBadges.includes('Primer Retiro')) {
          newBadges.push('Primer Retiro');
          badgeEarned = 'Primer Retiro';
          pointsToAdd = 100;
        }
      }

      const newPoints = stats.points + pointsToAdd;
      const newLevel = Math.floor(newPoints / 500) + 1;
      const levelUp = newLevel > stats.level;

      db.prepare(`
        UPDATE user_stats SET
          points = ?,
          level = ?,
          badges = ?,
          visitedPlatforms = ?
        WHERE userId = ?
      `).run(newPoints, newLevel, JSON.stringify(newBadges), JSON.stringify(visitedPlatforms), userId);

      res.json({
        success: true,
        pointsEarned: pointsToAdd,
        newTotalPoints: newPoints,
        newLevel,
        levelUp,
        badgeEarned
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to process action" });
    }
  });

  // Earnings History
  app.get("/api/earnings-history/:userId", (req, res) => {
    const { userId } = req.params;
    try {
      const history = db.prepare(`
        SELECT
          date(timestamp) as date,
          SUM(amount) as total
        FROM earnings_history
        WHERE userId = ?
        AND timestamp >= date('now', '-7 days')
        GROUP BY date(timestamp)
        ORDER BY date ASC
      `).all(userId);
      res.json(history);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch earnings history" });
    }
  });

  app.post("/api/earnings", (req, res) => {
    const { userId, amount, platformId } = req.body;
    const timestamp = new Date().toISOString();

    const transaction = db.transaction(() => {
      db.prepare("INSERT INTO earnings_history (userId, amount, timestamp, platformId) VALUES (?, ?, ?, ?)").run(userId, amount, timestamp, platformId);
      db.prepare("UPDATE user_stats SET currentEarnings = currentEarnings + ? WHERE userId = ?").run(amount, userId);
    });

    transaction();
    res.json({ success: true });
  });

  // API Route to check website status
  app.post("/api/check-status", async (req, res) => {
    const { urls } = req.body;

    if (!urls || !Array.isArray(urls)) {
      return res.status(400).json({ error: "Invalid URLs provided" });
    }

    const checkStatus = async (url: string) => {
      try {
        const response = await axios.get(url, {
          timeout: 5000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          },
          validateStatus: () => true
        });
        return { url, status: response.status >= 200 && response.status < 400 ? 'online' : 'error' };
      } catch (error) {
        return { url, status: 'offline' };
      }
    };

    const results = await Promise.all(urls.map(checkStatus));
    res.json({ results });
  });

  // Vite middleware for development
  console.log(`NODE_ENV is: ${process.env.NODE_ENV}`);
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "custom",
    });
    app.use(vite.middlewares);

    app.use(async (req, res, next) => {
      console.log("Catch-all route hit for URL:", req.originalUrl);
      try {
        const url = req.originalUrl;
        if (url.startsWith('/api')) return next();
        let template = await fs.readFile(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e: any) {
        console.error("Catch-all route error:", e);
        vite.ssrFixStacktrace(e);
        next(e);
      }
    });
  } else {
    console.log("Production block hit");
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'), (err) => {
        if (err) console.error("sendFile error:", err);
      });
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
