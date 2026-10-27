
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: process.env.CLIENT_ORIGIN || '*',
        methods: ['GET', 'POST']
    }
});

const rooms = new Map();
const MAX_PLAYERS = 10;

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'PlayCanvas multiplayer room server'
    });
});

function makeCode() {
    let code;

    do {
        code = crypto.randomBytes(3).toString('hex').toUpperCase();
    } while (rooms.has(code));

    return code;
}

function cleanName(value) {
    return typeof value === 'string'
        ? value.trim().slice(0, 24)
        : '';
}

function roomSnapshot(room) {
    return {
        code: room.code,
        hostId: room.hostId,
        capacity: room.capacity,
        mapIndex: room.mapIndex,
        players: Array.from(room.players.values())
    };
}

function leaveRoom(socket) {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    socket.data.roomCode = null;

    socket.leave(code);

    if (!room) return;

    room.players.delete(socket.id);

    if (room.players.size === 0) {
        rooms.delete(code);
        return;
    }

    if (room.hostId === socket.id) {
        room.hostId = room.players.keys().next().value;
    }

    io.to(code).emit('roomState', roomSnapshot(room));
}

function fail(ack, message) {
    if (typeof ack === 'function') {
        ack({ ok: false, error: message });
    }
}

io.on('connection', socket => {
    socket.data.roomCode = null;

    socket.on('createRoom', (data = {}, ack) => {
        if (socket.data.roomCode) leaveRoom(socket);

        const name = cleanName(data.name);
        if (!name) return fail(ack, 'Enter a player name.');

        const requested = Number(data.capacity);
        const capacity = Number.isFinite(requested)
            ? Math.max(2, Math.min(MAX_PLAYERS, Math.floor(requested)))
            : MAX_PLAYERS;

        const mapIndex = Number.isInteger(data.mapIndex) &&
            data.mapIndex >= 0 && data.mapIndex <= 6
            ? data.mapIndex : 0;

        const code = makeCode();

        const room = {
            code,
            hostId: socket.id,
            capacity,
            mapIndex,
            players: new Map()
        };

        room.players.set(socket.id, {
            id: socket.id,
            name,
            x: 0,
            y: 0,
            z: 0
        });

        rooms.set(code, room);
        socket.data.roomCode = code;
        socket.join(code);

        const result = roomSnapshot(room);
        if (typeof ack === 'function') {
            ack({ ok: true, room: result });
        }

        io.to(code).emit('roomState', result);
    });

    socket.on('joinRoom', (data = {}, ack) => {
        if (socket.data.roomCode) leaveRoom(socket);

        const name = cleanName(data.name);
        const code = typeof data.code === 'string'
            ? data.code.trim().toUpperCase()
            : '';

        if (!name) return fail(ack, 'Enter a player name.');

        const room = rooms.get(code);
        if (!room) return fail(ack, 'Room not found.');

        if (room.players.size >= room.capacity) {
            return fail(ack, 'This room is full.');
        }

        room.players.set(socket.id, {
            id: socket.id,
            name,
            x: 0,
            y: 0,
            z: 0
        });

        socket.data.roomCode = code;
        socket.join(code);

        if (typeof ack === 'function') {
            ack({ ok: true, room: roomSnapshot(room) });
        }

        io.to(code).emit('roomState', roomSnapshot(room));
    });

    socket.on('playerMove', data => {
        const code = socket.data.roomCode;
        const room = rooms.get(code);
        if (!room || !room.players.has(socket.id)) return;

        const player = room.players.get(socket.id);
        const values = ['x', 'y', 'z'];

        for (const key of values) {
            if (Number.isFinite(data?.[key])) {
                player[key] = Math.max(-10000,
                    Math.min(10000, data[key]));
            }
        }

        socket.to(code).emit('playerMoved', {
            id: socket.id,
            x: player.x,
            y: player.y,
            z: player.z
        });
    });

    socket.on('changeMap', (data, ack) => {
        const room = rooms.get(socket.data.roomCode);
        if (!room) return fail(ack, 'You are not in a room.');

        if (room.hostId !== socket.id) {
            return fail(ack, 'Only the host can change the map.');
        }

        if (!Number.isInteger(data?.mapIndex) ||
            data.mapIndex < 0 || data.mapIndex > 6) {
            return fail(ack, 'Invalid map selection.');
        }

        room.mapIndex = data.mapIndex;
        io.to(room.code).emit('roomState', roomSnapshot(room));

        if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('leaveRoom', () => leaveRoom(socket));
    socket.on('disconnect', () => leaveRoom(socket));
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log('Room server listening on port ' + PORT);
});
