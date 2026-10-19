import { defineServer, defineRoom, monitor, WebSocketTransport } from "colyseus";
import { matchMaker } from "@colyseus/core";
import express from "express";
import path from "path";
import { migrateSettledMatches } from "./settledMatches";
import { migratePushSubscriptions } from "./pushNotifications";
import { migrateMatchPayments, webhookHandler } from "./entryPayments";
import { LobbyRoom } from "./rooms/LobbyRoom";
import { GameRoom } from "./rooms/GameRoom";
import { TwinRoom } from "./rooms/TwinRoom";
import { prizesClientScript } from "./prizes";

export const server = defineServer({
    // Heartbeat: ping every 10 s, drop a connection after 3 missed pings
    // (~30 s), so a quick app switch on a phone isn't treated as leaving.
    transport: new WebSocketTransport({ pingInterval: 10000, pingMaxRetries: 3 }),

    rooms: {
        lobby_room: defineRoom(LobbyRoom),
        game_room:  defineRoom(GameRoom),
        twin_room:  defineRoom(TwinRoom).filterBy(['room']),   // each player's second connection (TwinRoom.ts)
    },

    express: (app) => {
        // Stripe webhook for entry fees (entryPayments.ts) — raw body, so it's
        // registered before any JSON middleware.
        app.post("/stripe/webhook", express.raw({ type: "application/json" }), webhookHandler("footy"));

        // Public, read-only status for the admin dashboard (same shape as Pong's).
        // Counts game_room instances only: the lobby_room never disposes.
        app.get("/status", async (_req, res) => {
            res.set("Access-Control-Allow-Origin", "*");
            const gameRooms = await matchMaker.query({ name: "game_room" });
            res.json({
                game: "FOOTY",
                activePlayers: gameRooms.reduce((sum, r) => sum + r.clients, 0),
                activeRooms: gameRooms.length,
                timestamp: new Date().toISOString()
            });
        });

        app.use("/colyseus", monitor());

        // The prize table (prizes.ts) for the lobby page — one source for labels and credits.
        app.get("/prizes.js", (_req, res) => {
            res.type("application/javascript").set("Cache-Control", "no-cache").send(prizesClientScript());
        });

        // Root → rooms lobby (before express.static so it wins over index.html)
        app.get('/', (_req, res) => {
            res.sendFile(path.join(__dirname, "../../client/dist/rooms.html"));
        });

        app.use(express.static(path.join(__dirname, "../../client/dist")));

        app.get(/^(?!\/colyseus).*/, (_req, res) => {
            res.sendFile(path.join(__dirname, "../../client/dist/rooms.html"));
        });
    },

    beforeListen: async () => {
        await migrateSettledMatches();
        await migratePushSubscriptions();
        await migrateMatchPayments();
    }
});

export default server;
