const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

// Original helper (used by groups and gamevisits)
async function roblox(path) {
    const res = await fetch("https://" + path, {
        headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
}

// Retry helper (used by followers and rap)
async function robloxWithRetry(path, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch("https://" + path, {
                headers: { "Accept": "application/json" }
            });
            if (res.status === 429) {
                await new Promise(r => setTimeout(r, 1000 * (i + 1)));
                continue;
            }
            if (!res.ok) throw new Error("HTTP " + res.status);
            return await res.json();
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 500 * (i + 1)));
        }
    }
}

// Followers count
app.get("/followers/:userId", async (req, res) => {
    try {
        const data = await robloxWithRetry(`friends.roblox.com/v1/users/${req.params.userId}/followers/count`);
        const count = data.count || 0;
        if (count === 0) {
            await new Promise(r => setTimeout(r, 1000));
            const retry = await robloxWithRetry(`friends.roblox.com/v1/users/${req.params.userId}/followers/count`);
            res.json({ count: retry.count || 0 });
        } else {
            res.json({ count });
        }
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
            
            const res2 = await fetch("https://" + url, {
                headers: { "Accept": "application/json" }
            });

            if (res2.status === 403) {
                isPrivate = true;
                break;
            }

            if (!res2.ok) throw new Error("HTTP " + res2.status);

            const data = await res2.json();

            if (!data.data) break;

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
            if (entry.role && entry.role.rank === 255) {
                ownedGroups.push(entry.group.id);
            }
        }
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

// Bot detection by sampling followers
app.get("/botcheck/:userId", async (req, res) => {
    try {
        const [followersData, followingData, userInfo] = await Promise.all([
            robloxWithRetry(`friends.roblox.com/v1/users/${req.params.userId}/followers/count`),
            robloxWithRetry(`friends.roblox.com/v1/users/${req.params.userId}/followings/count`),
            robloxWithRetry(`users.roblox.com/v1/users/${req.params.userId}`)
        ]);

        const followers = followersData.count || 0;
        const following = followingData.count || 0;
        const created = new Date(userInfo.created);
        const ageDays = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24);

        let botScore = 0;

        // Basic checks
        if (followers > 1000 && following < 10) botScore += 2;
        if (ageDays > 0 && (followers / ageDays) > 1000) botScore += 3;
        if (ageDays < 90 && followers > 5000) botScore += 2;

        // Sample 20 most recent followers and check if they look like bots
        if (followers > 500) {
            try {
                const followerList = await robloxWithRetry(
                    `friends.roblox.com/v1/users/${req.params.userId}/followers?limit=20&sortOrder=Desc`
                );

                let suspiciousCount = 0;
                const sample = followerList.data || [];

                await Promise.all(sample.map(async (follower) => {
                    try {
                        const [theirFollowers, theirFriends] = await Promise.all([
                            robloxWithRetry(`friends.roblox.com/v1/users/${follower.id}/followers/count`),
                            robloxWithRetry(`friends.roblox.com/v1/users/${follower.id}/friends/count`)
                        ]);

                        const theirFollowerCount = theirFollowers.count || 0;
                        const theirFriendCount = theirFriends.count || 0;

                        // Bot pattern: very few followers AND very few friends
                        if (theirFollowerCount <= 5 && theirFriendCount <= 5) {
                            suspiciousCount++;
                        }
                    } catch (_) {}
                }));

                const botRatio = suspiciousCount / Math.max(sample.length, 1);

                if (botRatio > 0.5) botScore += 4;
                else if (botRatio > 0.3) botScore += 2;

            } catch (_) {}
        }

        res.json({ isBotted: botScore >= 3, botScore });

    } catch (e) {
        res.json({ isBotted: false, botScore: 0, error: e.message });
    }
});

app.listen(PORT, () => console.log("Proxy running on port " + PORT));
