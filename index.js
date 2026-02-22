const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

// Helper to fetch JSON from Roblox
async function roblox(path) {
    const res = await fetch("https://" + path, {
        headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
}

// Followers count
app.get("/followers/:userId", async (req, res) => {
    try {
        const data = await roblox(`friends.roblox.com/v1/users/${req.params.userId}/followers/count`);
        res.json({ count: data.count });
    } catch (e) {
        res.json({ count: 0, error: e.message });
    }
});

// RAP (handles pagination through all pages)
app.get("/rap/:userId", async (req, res) => {
    try {
        let rap = 0;
        let cursor = "";
        let isPrivate = false;

        do {
            const url = `inventory.roblox.com/v1/users/${req.params.userId}/assets/collectibles?sortOrder=Asc&limit=100${cursor ? "&cursor=" + cursor : ""}`;
            const data = await roblox(url);

            if (!data.data) { isPrivate = true; break; }

            for (const item of data.data) {
                rap += item.recentAveragePrice || 0;
            }

            cursor = data.nextPageCursor || "";
        } while (cursor);

        res.json({ rap, isPrivate });
    } catch (e) {
        res.json({ rap: 0, isPrivate: true, error: e.message });
    }
});

// All groups a user owns + total combined member count
app.get("/groups/:userId", async (req, res) => {
    try {
        const data = await roblox(`groups.roblox.com/v2/users/${req.params.userId}/groups/roles`);
        
        let totalMembers = 0;
        const ownedGroups = [];

        for (const entry of data.data || []) {
            // Only count groups where the player is the owner (roleRank 255 = Owner)
            if (entry.role && entry.role.rank === 255) {
                ownedGroups.push(entry.group.id);
            }
        }

        // Fetch member count for each owned group
        await Promise.all(ownedGroups.map(async (groupId) => {
            try {
                const groupData = await roblox(`groups.roblox.com/v1/groups/${groupId}`);
                totalMembers += groupData.memberCount || 0;
            } catch (_) {}
        }));

        res.json({ totalMembers, groupCount: ownedGroups.length });
    } catch (e) {
        res.json({ totalMembers: 0, groupCount: 0, error: e.message });
    }
});

// Get total visits across all games a user has created
app.get("/gamevisits/:userId", async (req, res) => {
    try {
        let totalVisits = 0;
        let cursor = "";

        do {
            const url = `games.roblox.com/v2/users/${req.params.userId}/games?sortOrder=Asc&limit=50${cursor ? "&cursor=" + cursor : ""}`;
            const data = await roblox(url);

            for (const game of data.data || []) {
                totalVisits += game.placeVisits || 0;
            }

            cursor = data.nextPageCursor || "";
        } while (cursor);

        res.json({ visits: totalVisits });
    } catch (e) {
        res.json({ visits: 0, error: e.message });
    }
});

app.listen(PORT, () => console.log("Proxy running on port " + PORT));
